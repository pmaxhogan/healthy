package dev.maxhogan.healthy.companion.hc

import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.Record
import java.io.File
import java.lang.reflect.Modifier
import java.util.jar.JarFile
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ties three lists together so none can drift: the record classes in the client library's jar,
 * [RecordTypes.ALL], and the manifest's health permissions.
 */
class RecordTypesTest {
    /** Every concrete class implementing [Record] in the jar that [Record] itself was loaded from. */
    private fun recordClassesInLibrary(): Set<String> {
        val jar = File(Record::class.java.protectionDomain!!.codeSource.location.toURI())
        val prefix = "androidx/health/connect/client/records/"
        return JarFile(jar).use { file ->
            file.entries().asSequence()
                .map { it.name }
                .filter { it.startsWith(prefix) && it.endsWith(".class") && !it.contains('$') }
                .map { it.removeSuffix(".class").replace('/', '.') }
                .filter { name ->
                    val cls = Class.forName(name, false, Record::class.java.classLoader)
                    Record::class.java.isAssignableFrom(cls) &&
                        !cls.isInterface &&
                        !Modifier.isAbstract(cls.modifiers)
                }
                .toSet()
        }
    }

    private fun manifestHealthPermissions(): List<String> {
        // Gradle runs unit tests with the module directory as the working directory.
        val manifest = File("src/main/AndroidManifest.xml")
        assertTrue("manifest not found at ${manifest.absolutePath}", manifest.isFile)
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(manifest)
        val nodes = document.getElementsByTagName("uses-permission")
        return (0 until nodes.length)
            .map { nodes.item(it).attributes.getNamedItem("android:name").nodeValue }
            .filter { it.startsWith("android.permission.health.") }
    }

    @Test
    fun listsEveryRecordClassInTheLibrary() {
        val listed = RecordTypes.ALL.map { it.java.name }
        assertEquals("a type is listed twice", listed.size, listed.toSet().size)
        assertEquals(recordClassesInLibrary().sorted(), listed.sorted())
    }

    @Test
    fun everyTypeHasAReadPermissionAndAWireName() {
        val names = RecordTypes.ALL.map { RecordTypes.typeName(it) }
        assertEquals("two types share a wire name", names.size, names.toSet().size)
        for (type in RecordTypes.ALL) {
            assertTrue(RecordTypes.readPermission(type).startsWith("android.permission.health.READ_"))
            assertTrue(RecordTypes.typeName(type).matches(Regex("^[A-Za-z][A-Za-z0-9]{0,63}$")))
        }
    }

    @Test
    fun manifestDeclaresExactlyThePermissionsTheTypesNeed() {
        val expected = RecordTypes.READ_PERMISSIONS + setOf(
            HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
            HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY,
            RecordTypes.READ_EXERCISE_ROUTES,
        )
        val declared = manifestHealthPermissions()
        assertEquals("a health permission is declared twice", declared.size, declared.toSet().size)
        assertEquals(expected.sorted(), declared.sorted())
        assertTrue("the app must never ask to write", declared.none { it.contains(".WRITE_") })
    }

    @Test
    fun grantAllAsksForEverythingWhenEveryFeatureIsAvailable() {
        val all = HealthAccess.requestable { true }
        assertEquals(manifestHealthPermissions().sorted(), all.sorted())
    }

    @Test
    fun grantAllLeavesOutWhatThePhoneDoesNotHave() {
        val none = HealthAccess.requestable { false }
        val gated = RecordTypes.ALL.filter { RecordTypes.requiredFeature(it) != null }
        assertEquals(3, gated.size)
        for (type in gated) assertTrue(RecordTypes.readPermission(type) !in none)
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND !in none)
        assertTrue(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY !in none)
        assertTrue(HealthPermission.getReadPermission(androidx.health.connect.client.records.StepsRecord::class) in none)
    }

    @Test
    fun derivesAGrantForEveryType() {
        val steps = "android.permission.health.READ_STEPS"
        val access = HealthAccess.derive(HealthConnectStatus.AVAILABLE, setOf(steps)) {
            it != HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE
        }
        assertEquals(RecordTypes.ALL.size, access.types.size)
        assertEquals(Grant.GRANTED, access.types["Steps"])
        // StepsCadence is gated by a different permission than Steps.
        assertEquals(Grant.DENIED, access.types["HeartRate"])
        assertEquals(Grant.UNAVAILABLE, access.types["SkinTemperature"])
        assertEquals(Grant.DENIED, access.backgroundRead)
        assertEquals(Grant.DENIED, access.exerciseRoutes)
        assertEquals(access.types.values.count { it == Grant.GRANTED }, access.grantedTypes)
        assertTrue(access.anythingToGrant)
    }

    @Test
    fun nothingIsReadableWhenHealthConnectIsNotAvailable() {
        val access = HealthAccess.derive(
            HealthConnectStatus.UPDATE_REQUIRED,
            RecordTypes.READ_PERMISSIONS,
        ) { true }
        assertTrue(access.types.values.all { it == Grant.UNAVAILABLE })
        assertEquals(Grant.UNAVAILABLE, access.historyRead)
        assertEquals(0, access.grantedTypes)
        assertTrue(!access.anythingToGrant)
    }

    @Test
    fun nothingLeftToGrantOnceEverythingIs() {
        val access = HealthAccess.derive(HealthConnectStatus.AVAILABLE, HealthAccess.requestable { true }) { true }
        assertEquals(RecordTypes.ALL.size, access.grantedTypes)
        assertTrue(!access.anythingToGrant)
    }
}
