package dev.maxhogan.healthy.companion.sync

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.zip.GZIPOutputStream
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull

/**
 * How large one upload may be.
 *
 * The targets are what the phone aims for; the hard caps are the server's own (8 MiB compressed,
 * 16 MiB of JSON, 25,000 upserts and deletes) and a batch over them is refused there with 413.
 * Nothing here limits how much is uploaded in total.
 */
data class BatchLimits(
    val targetGzipBytes: Int = 1 shl 20,
    val targetRawBytes: Int = 6 shl 20,
    val targetItems: Int = 20_000,
    val hardGzipBytes: Int = 8 shl 20,
    val hardRawBytes: Int = 16 shl 20,
    val hardItems: Int = 25_000,
)

/** One thing a batch carries: a record to store, or the id of one to delete. */
sealed interface BatchItem {
    /** Bytes this item adds to the raw JSON body. */
    val rawBytes: Int

    /** True for the phone's own `Agg.*` records, which are not counted as uploaded records. */
    val synthetic: Boolean

    class Upsert(
        val json: String,
        val id: String,
        val startMs: Long?,
        val endMs: Long?,
        override val synthetic: Boolean,
        /** True when this stands in for a record too large to send. */
        val stub: Boolean = false,
        /** The record's own `lastModified`, when it carries one: what tells an edit from a repeat. */
        val lastModified: Long? = null,
    ) : BatchItem {
        override val rawBytes: Int = utf8Length(json) + 1
    }

    class Delete(val id: String, override val synthetic: Boolean = false) : BatchItem {
        override val rawBytes: Int = utf8Length(id) + 3
    }

    companion object {
        /** A Health Connect record as the serializer produced it. */
        fun record(wire: JsonObject): Upsert = Upsert(
            json = wire.toString(),
            id = wire.string("id").orEmpty(),
            startMs = wire.long("start") ?: wire.long("time"),
            endMs = wire.long("end") ?: wire.long("time"),
            synthetic = false,
            lastModified = wire.long("lastModified"),
        )

        /** The synthetic record for one UTC hour of a platform aggregate. */
        fun aggregate(metric: AggMetric, hour: HourAggregate, nowMs: Long): Upsert {
            val id = metric.recordId(hour.hourStartMs)
            val wire = buildJsonObject {
                put("id", JsonPrimitive(id))
                put("type", JsonPrimitive(metric.wireType))
                put("origin", JsonPrimitive(AGG_ORIGIN))
                put("lastModified", JsonPrimitive(nowMs))
                put("start", JsonPrimitive(hour.hourStartMs))
                put("end", JsonPrimitive(hour.hourStartMs + Hours.MS))
                put(
                    "data",
                    buildJsonObject {
                        put("value", JsonPrimitive(hour.value))
                        put("unit", JsonPrimitive(metric.unit))
                        put("origins", JsonArray(hour.origins.sorted().map(::JsonPrimitive)))
                    },
                )
            }
            return Upsert(
                json = wire.toString(),
                id = id,
                startMs = hour.hourStartMs,
                endMs = hour.hourStartMs + Hours.MS,
                synthetic = true,
            )
        }

        /**
         * What goes up in place of a record that is over the server's limits even alone: the
         * same id, type, origin, times and metadata, with `data` replaced by a note of what
         * happened and how large the record was. The gap is then visible on the server instead
         * of blocking everything behind it. Null when [item] is itself a stub or is not a
         * record the serializer produced.
         */
        fun oversizeStub(item: Upsert): Upsert? {
            if (item.stub || item.synthetic) return null
            val wire = try {
                Json.parseToJsonElement(item.json) as? JsonObject
            } catch (_: SerializationException) {
                null
            } ?: return null
            val stubbed = JsonObject(
                wire + (
                    "data" to buildJsonObject {
                        put("oversize", JsonPrimitive(true))
                        put("bytes", JsonPrimitive(item.rawBytes - 1))
                    }
                    ),
            )
            return Upsert(
                stubbed.toString(),
                item.id,
                item.startMs,
                item.endMs,
                synthetic = false,
                stub = true,
                lastModified = item.lastModified,
            )
        }

        const val AGG_ORIGIN = "healthconnect"

        private fun JsonObject.string(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun JsonObject.long(key: String): Long? =
            (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
    }
}

/** A batch ready to send. Equality is not defined: compare [batchId]. */
class EncodedBatch(
    val batchId: String,
    val items: List<BatchItem>,
    val rawBytes: Int,
    val gzip: ByteArray,
    /** True when the id was minted at random rather than derived from the body. */
    val freshId: Boolean = false,
) {
    fun exceeds(limits: BatchLimits): Boolean =
        gzip.size > limits.hardGzipBytes || rawBytes > limits.hardRawBytes || items.size > limits.hardItems
}

/**
 * Turns items into upload bodies: the envelope, the size split and the batch id.
 *
 * The batch id is a digest of where the items came from ([position]: a record type with a
 * changes token, or with a month and page token) and of every byte of the body around it. The
 * server acknowledges a repeated id without applying it again, and refuses with 409 an id that
 * comes back with different bytes, so the rule has to be exact: the same bytes always carry the
 * same id, and different bytes never do. That covers the case that matters, a batch the server
 * took whose answer was lost and which is sent again unchanged. A position read again in a later
 * run produces a new body (new `phoneTime`, new `syncState`, possibly new changes behind the
 * same token) and therefore a new id; the server's upserts and deletes are idempotent by record
 * id, so sending the overlap twice changes nothing.
 */
class BatchEncoder(
    private val deviceId: String,
    private val appVersion: String,
    private val limits: BatchLimits = BatchLimits(),
) {
    /**
     * Splits [items] into batches no larger than the targets, in order. A single item larger
     * than a target still gets a batch of its own. No items yields one batch that carries only
     * [syncState].
     */
    fun plan(position: String, items: List<BatchItem>, syncState: String?, phoneTime: Long): List<EncodedBatch> {
        if (items.isEmpty()) return listOf(encode(position, items, syncState, phoneTime))
        val overhead = ENVELOPE_BYTES + (syncState?.let(::utf8Length) ?: 0)
        val out = ArrayList<EncodedBatch>()
        var chunk = ArrayList<BatchItem>()
        var size = overhead
        for (item in items) {
            val full = size + item.rawBytes > limits.targetRawBytes || chunk.size >= limits.targetItems
            if (chunk.isNotEmpty() && full) {
                splitByGzip(position, chunk, syncState, phoneTime, out)
                chunk = ArrayList()
                size = overhead
            }
            chunk.add(item)
            size += item.rawBytes
        }
        splitByGzip(position, chunk, syncState, phoneTime, out)
        return out
    }

    /** The two halves of [batch], or null when it holds a single item and cannot be split. */
    fun halve(position: String, batch: EncodedBatch, syncState: String?, phoneTime: Long): List<EncodedBatch>? {
        if (batch.items.size < 2) return null
        val middle = batch.items.size / 2
        return listOf(
            encode(position, batch.items.subList(0, middle), syncState, phoneTime),
            encode(position, batch.items.subList(middle, batch.items.size), syncState, phoneTime),
        )
    }

    /** The same items under a random id: the answer to the server's 409 for a reused id. */
    fun remint(position: String, batch: EncodedBatch, syncState: String?, phoneTime: Long): EncodedBatch =
        encode(position, batch.items, syncState, phoneTime, freshId = true)

    private fun splitByGzip(
        position: String,
        items: List<BatchItem>,
        syncState: String?,
        phoneTime: Long,
        out: MutableList<EncodedBatch>,
    ) {
        val batch = encode(position, items, syncState, phoneTime)
        if (batch.gzip.size <= limits.targetGzipBytes || items.size < 2) {
            out.add(batch)
            return
        }
        val middle = items.size / 2
        splitByGzip(position, items.subList(0, middle), syncState, phoneTime, out)
        splitByGzip(position, items.subList(middle, items.size), syncState, phoneTime, out)
    }

    fun encode(
        position: String,
        items: List<BatchItem>,
        syncState: String?,
        phoneTime: Long,
        freshId: Boolean = false,
    ): EncodedBatch {
        val head = StringBuilder(ENVELOPE_BYTES)
        head.append("{\"v\":1,\"deviceId\":").append(JsonPrimitive(deviceId))
        head.append(",\"appVersion\":").append(JsonPrimitive(appVersion))
        head.append(",\"batchId\":")
        val tail = StringBuilder(ENVELOPE_BYTES + items.sumOf { it.rawBytes })
        tail.append(",\"phoneTime\":").append(phoneTime)
        tail.append(",\"upserts\":[")
        var first = true
        for (item in items) {
            if (item !is BatchItem.Upsert) continue
            if (!first) tail.append(',')
            tail.append(item.json)
            first = false
        }
        tail.append("],\"deletes\":[")
        first = true
        for (item in items) {
            if (item !is BatchItem.Delete) continue
            if (!first) tail.append(',')
            tail.append(JsonPrimitive(item.id))
            first = false
        }
        tail.append(']')
        if (syncState != null) tail.append(",\"syncState\":").append(syncState)
        tail.append('}')

        val headBytes = head.toString().toByteArray(Charsets.UTF_8)
        val tailBytes = tail.toString().toByteArray(Charsets.UTF_8)
        // A batch with nothing in it carries only the state report, which is never a replay.
        val random = freshId || items.isEmpty()
        val batchId = if (random) UUID.randomUUID().toString() else batchId(position, headBytes, tailBytes)
        val idBytes = JsonPrimitive(batchId).toString().toByteArray(Charsets.UTF_8)
        val raw = headBytes + idBytes + tailBytes
        return EncodedBatch(batchId, items.toList(), raw.size, gzip(raw), random)
    }

    private fun batchId(position: String, head: ByteArray, tail: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("healthy.batch.v2".toByteArray(Charsets.UTF_8))
        digest.update(SEPARATOR)
        digest.update(position.toByteArray(Charsets.UTF_8))
        digest.update(SEPARATOR)
        digest.update(head)
        digest.update(SEPARATOR)
        digest.update(tail)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest())
    }

    private companion object {
        /** Room for the envelope's fixed fields. An estimate: the real size is measured. */
        const val ENVELOPE_BYTES = 512
        val SEPARATOR = byteArrayOf(0x1e)

        fun gzip(raw: ByteArray): ByteArray {
            val bytes = ByteArrayOutputStream(raw.size / 4 + 64)
            GZIPOutputStream(bytes).use { it.write(raw) }
            return bytes.toByteArray()
        }
    }
}

/** UTF-8 length of [text] without allocating the bytes. */
internal fun utf8Length(text: String): Int {
    var bytes = 0
    var index = 0
    while (index < text.length) {
        val c = text[index]
        when {
            c.code < 0x80 -> bytes += 1
            c.code < 0x800 -> bytes += 2
            Character.isHighSurrogate(c) && index + 1 < text.length && Character.isLowSurrogate(text[index + 1]) -> {
                bytes += 4
                index++
            }
            else -> bytes += 3
        }
        index++
    }
    return bytes
}
