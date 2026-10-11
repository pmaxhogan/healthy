plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Version scheme: VERSION file holds "major.minor"; patch is the number of
// commits on the current branch, so every push to main is a new, monotonic
// release. CI passes HEALTHY_PATCH explicitly; local builds derive it from git.
// The count is repository-wide (this is a monorepo), which only makes the
// patch number climb faster.
val baseVersion = rootProject.file("VERSION").readText().trim()
val patch: Int = (System.getenv("HEALTHY_PATCH")
    ?: providers.exec {
        commandLine("git", "rev-list", "--count", "HEAD")
        isIgnoreExitValue = true
    }.standardOutput.asText.get().trim().ifEmpty { "0" }).toInt()
val (major, minor) = baseVersion.split(".").map { it.toInt() }
// The version code gives the patch four digits and the minor two. One more would spill into the
// next field and produce a code that collides with, or sorts below, another release, which an
// installer would refuse or, worse, treat as a downgrade. Fail here instead: bump VERSION.
require(minor in 0..99 && patch in 0..9_999) {
    "Version $major.$minor.$patch does not fit versionCode = major*1_000_000 + minor*10_000 + patch " +
        "(minor must be 0..99, patch 0..9999). The patch is the repository's commit count, so the " +
        "scheme itself has to change before this build can be released."
}
val computedVersionName = "$major.$minor.$patch"
val computedVersionCode = major * 1_000_000 + minor * 10_000 + patch

android {
    namespace = "dev.maxhogan.healthy.companion"
    compileSdk = 37
    compileSdkMinor = 2

    defaultConfig {
        applicationId = "dev.maxhogan.healthy.companion"
        // Android 17 only. Health Connect is part of the platform from API 34,
        // so everything above that is free of compatibility branches; 37 is
        // the newest level there is a device for, and R8 drops every
        // SDK_INT-guarded fallback in the libraries below it.
        minSdk = 37
        targetSdk = 37
        versionCode = computedVersionCode
        versionName = computedVersionName
        // Every Android 17 device is 64-bit. Dropping the 32-bit copies of the camera
        // library's native code halves its share of the APK; x86_64 stays for the emulator.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    signingConfigs {
        create("release") {
            val storeFilePath = System.getenv("HEALTHY_KEYSTORE_PATH")
            if (storeFilePath != null) {
                storeFile = file(storeFilePath)
                storePassword = System.getenv("HEALTHY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("HEALTHY_KEY_ALIAS")
                keyPassword = System.getenv("HEALTHY_KEY_PASSWORD")
                // v3 on top of v2: it is what lets the signing key be rotated
                // later without every install having to be removed first.
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (System.getenv("HEALTHY_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        lintConfig = file("lint.xml")
        warningsAsErrors = false
        abortOnError = true
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

// The app reads every record type Health Connect has, including the ones the client library
// still marks experimental, so those opt-ins are module-wide rather than repeated per file.
kotlin {
    compilerOptions {
        optIn.add("androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.health.connect.client)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
