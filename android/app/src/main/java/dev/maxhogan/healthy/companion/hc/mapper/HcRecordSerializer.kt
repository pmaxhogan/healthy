package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.records.Record
import kotlinx.serialization.json.JsonObject

/**
 * Record -> wire JSON. One hand-written mapper per Record class the pinned client library ships
 * ([HcMappers]); anything else (a class a newer library adds, or a mapper that throws) goes to
 * [fallback], so a single odd record can never fail a whole batch.
 */
class HcRecordSerializer(
    private val fallback: RecordSerializer = ReflectiveRecordSerializer(),
) : RecordSerializer {
    private val byClass: Map<Class<*>, RecordMapper<*>> =
        HcMappers.all.associateBy { it.recordClass }

    override fun serialize(record: Record): JsonObject {
        val mapper = byClass[record.javaClass] ?: return fallback.serialize(record)
        return try {
            @Suppress("UNCHECKED_CAST") // the registry is keyed by the mapper's own record class
            val m = mapper as RecordMapper<Record>
            val mapped = m.apply(record)
            Envelope.build(m.type, record.metadata, mapped.timing, mapped.data)
        } catch (e: Exception) {
            fallback.serialize(record)
        }
    }

    /** Wire `type` names of every hand-written mapper, by library class. */
    companion object {
        fun mappedClasses(): Set<Class<*>> = HcMappers.all.map { it.recordClass }.toSet()

        fun mappedTypeNames(): List<String> = HcMappers.all.map { it.type }
    }
}
