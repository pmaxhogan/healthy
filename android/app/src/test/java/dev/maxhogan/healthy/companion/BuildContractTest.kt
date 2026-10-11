package dev.maxhogan.healthy.companion

import dev.maxhogan.healthy.companion.ui.Format
import dev.maxhogan.healthy.companion.ui.RATIONALE
import java.io.File
import java.time.ZoneOffset
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Things the release process and the privacy posture depend on, checked from the built module. */
class BuildContractTest {
    @Test
    fun versionCodeFollowsFromVersionName() {
        val parts = BuildConfig.VERSION_NAME.split(".").map { it.toInt() }
        assertEquals("versionName is major.minor.patch", 3, parts.size)
        val (major, minor, patch) = parts
        assertEquals(major * 1_000_000 + minor * 10_000 + patch, BuildConfig.VERSION_CODE)
    }

    @Test
    fun versionNameStartsWithTheVersionFile() {
        // Unit tests run with the module directory as the working directory.
        val base = File("../VERSION").readText().trim()
        assertTrue(base.matches(Regex("""\d+\.\d+""")))
        assertTrue(BuildConfig.VERSION_NAME.startsWith("$base."))
    }

    private fun securityConfig(path: String) =
        DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(path))

    @Test
    fun releaseBuildAllowsNoCleartextAtAll() {
        val config = securityConfig("src/main/res/xml/network_security_config.xml")
        val base = config.getElementsByTagName("base-config")
        assertEquals(1, base.length)
        assertEquals("false", base.item(0).attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        assertEquals(0, config.getElementsByTagName("domain-config").length)
        assertEquals(0, config.getElementsByTagName("domain").length)
        // Nothing but the debug source set may override it.
        assertEquals(false, File("src/release/res/xml/network_security_config.xml").exists())
    }

    @Test
    fun debugBuildAllowsCleartextOnlyForLoopback() {
        val config = securityConfig("src/debug/res/xml/network_security_config.xml")
        val base = config.getElementsByTagName("base-config")
        assertEquals(1, base.length)
        assertEquals("false", base.item(0).attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)

        val domains = config.getElementsByTagName("domain")
        val hosts = (0 until domains.length).map { domains.item(it).textContent.trim() }
        assertEquals(listOf("127.0.0.1", "localhost"), hosts.sorted())
        for (index in 0 until domains.length) {
            assertEquals("false", domains.item(index).attributes.getNamedItem("includeSubdomains").nodeValue)
        }
    }

    @Test
    fun versionSchemeFailsTheBuildBeforeTheCodeCanCollide() {
        val script = File("build.gradle.kts").readText()
        assertTrue(script.contains("require(minor in 0..99 && patch in 0..9_999)"))
        val (_, minor, patch) = BuildConfig.VERSION_NAME.split(".").map { it.toInt() }
        assertTrue(minor in 0..99 && patch in 0..9_999)
    }

    @Test
    fun theLibrarysExportedCallbackServiceIsRemoved() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(
            Regex(
                "<service\\s+android:name=\"androidx\\.health\\.platform\\.client\\.impl\\.sdkservice\\.HealthDataSdkService\"\\s+tools:node=\"remove\"",
            ).containsMatchIn(manifest),
        )
    }

    @Test
    fun manifestNeverEnablesCleartextOrBackups() {
        val manifest = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File("src/main/AndroidManifest.xml"))
        val application = manifest.getElementsByTagName("application").item(0).attributes
        assertEquals(null, application.getNamedItem("android:usesCleartextTraffic"))
        assertEquals("false", application.getNamedItem("android:allowBackup").nodeValue)
    }

    @Test
    fun rationaleDescribesTheSoftware() {
        assertTrue(RATIONALE.isNotEmpty())
        val text = RATIONALE.joinToString(" ") { "${it.first} ${it.second}" }
        assertTrue(text.contains("no analytics"))
        assertTrue(text.contains("never asks to write"))
    }

    @Test
    fun formatsTimestampsInTheGivenZone() {
        assertEquals("1970-01-02", Format.date(86_400_000L, ZoneOffset.UTC))
        assertEquals("1970-01-01", Format.date(86_400_000L, ZoneOffset.ofHours(-1)))
        assertEquals("—", Format.date(null))
        assertEquals("—", Format.dateTime(null))
        assertEquals("healthy.example", Format.host("https://healthy.example:8443"))
    }
}
