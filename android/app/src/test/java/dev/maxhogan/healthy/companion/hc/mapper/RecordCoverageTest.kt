package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.StepsRecord
import java.io.File
import java.lang.reflect.Modifier
import java.util.jar.JarFile
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE COVERAGE ASSERTION. Scans the Health Connect client library on the test classpath for every
 * concrete [Record] subclass and fails if any has no hand-written mapper, so a library bump that
 * adds a record type breaks the build instead of silently routing it to the reflection fallback.
 */
class RecordCoverageTest {
    private val recordsPackage = "androidx/health/connect/client/records/"

    private fun libraryRecordClasses(): List<Class<*>> {
        val location = StepsRecord::class.java.protectionDomain.codeSource.location
        val root = File(location.toURI())
        val names =
            if (root.isDirectory) {
                File(root, recordsPackage).list().orEmpty().toList()
            } else {
                JarFile(root).use { jar ->
                    jar.entries()
                        .asSequence()
                        .map { it.name }
                        .filter {
                            it.startsWith(recordsPackage) &&
                                it.indexOf('/', recordsPackage.length) < 0
                        }
                        .map { it.removePrefix(recordsPackage) }
                        .toList()
                }
            }
        return names
            .filter { it.endsWith(".class") && !it.contains('$') }
            .map { Class.forName(recordsPackage.replace('/', '.') + it.removeSuffix(".class")) }
            .filter {
                Record::class.java.isAssignableFrom(it) &&
                    !it.isInterface &&
                    !Modifier.isAbstract(it.modifiers)
            }
    }

    @Test
    fun everyConcreteRecordClassInTheLibraryHasAHandWrittenMapper() {
        val found = libraryRecordClasses()
        // Guard against a scan that silently finds nothing (e.g. a repackaged jar layout).
        assertTrue("record scan found only ${found.size} classes", found.size >= 40)
        val mapped = HcRecordSerializer.mappedClasses()
        val missing = found.filter { it !in mapped }.map { it.simpleName }.sorted()
        assertTrue(
            "Record classes with no mapper (add one to HcMappers and a fixture to RecordFixtures): $missing",
            missing.isEmpty(),
        )
    }

    @Test
    fun noMapperTargetsAClassTheLibraryDoesNotShip() {
        val found = libraryRecordClasses().toSet()
        val stale = HcRecordSerializer.mappedClasses().filter { it !in found }.map { it.simpleName }
        assertTrue("mappers for classes missing from the library: $stale", stale.isEmpty())
    }

    @Test
    fun wireTypeNamesAreUniqueAndMatchTheWireRegex() {
        val names = HcRecordSerializer.mappedTypeNames()
        assertTrue("duplicate type names", names.size == names.toSet().size)
        val re = Regex("^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
        assertTrue(names.all { re.matches(it) })
    }
}
