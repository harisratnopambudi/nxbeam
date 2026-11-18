import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// the app version follows the NXBeam release (package.json)
@Suppress("UNCHECKED_CAST")
val pkg = JsonSlurper().parse(rootProject.file("../package.json")) as Map<String, Any>
val appVersion = pkg["version"] as String
val parts = appVersion.split(".").map { it.toInt() }
// Android only installs a higher versionCode over an older one: on CI it follows
// the run number (always rising), above every code the version number gave
val runNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 0
val appCode = if (runNumber > 0) 20000 + runNumber else (parts[0] * 10000 + parts[1] * 100 + parts[2])

android {
    namespace = "com.harisdevlab.nxbeam"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.harisdevlab.nxbeam"
        minSdk = 26
        targetSdk = 35
        versionCode = appCode
        versionName = appVersion
        // the release's build number: online updates compare it with latest.json (0: never update)
        buildConfigField("int", "BUILD_NUMBER", "$runNumber")
    }

    signingConfigs {
        // a public key, kept in the repo so every build can update the last one
        create("release") {
            storeFile = file("nxbeam-release.jks")
            storePassword = "nxbeam-public"
            keyAlias = "nxbeam"
            keyPassword = "nxbeam-public"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { abortOnError = false; checkReleaseBuilds = false }
}
