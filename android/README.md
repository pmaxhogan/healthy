# Healthy Companion (Android)

The phone half of Healthy. It reads every Health Connect record type it is
granted, in the background, and uploads them to the one Healthy server it was
paired with. It has no analytics, no crash reporting and no third-party
services, and it never writes to Health Connect.

Requires Android 17 (API 37): `minSdk` and `targetSdk` are both 37, and the
build compiles against 37.2. The application id is
`dev.maxhogan.healthy.companion`; debug builds install side by side as
`dev.maxhogan.healthy.companion.debug`. Backups and device transfer are
disabled.

## Install

Releases are published on this repository's GitHub releases page as
`healthy-companion-<major>.<minor>.<patch>.apk`. With
[Obtainium](https://github.com/ImranR98/Obtainium) installed, open this link on
the phone to track them:

```
obtainium://add/https://github.com/pmaxhogan/healthy
```

`obtainium.json` in this directory is the same app definition as an importable
file. Its APK filter is `healthy-companion-.*\.apk`.

## Pair

1. In the server's admin UI, open the Phone page and press **Pair a phone**. It
   shows a QR code and, under it, the same text as a copyable **Pairing code**,
   once.
2. In the app, tap **Pair**, then **Scan QR code**. Confirm the server shown.
3. Tap **Grant all** and allow the Health Connect permissions, then tap
   **Exempt from battery optimisation**, **Keep permissions when unused** and
   **Allow notifications**, which the status screen offers until they are done.
   Exercise routes are granted from **Open Health Connect**.

The pairing code is JSON, `{"v":1,"url":"…","deviceId":"…","token":"…"}`, exactly
what the QR encodes, and can be pasted as text instead of scanned (the **Pairing
code (JSON)** box, then **Use pasted code**), which is the way in on an emulator.
The URL must be a bare origin and `https`. A release build accepts nothing else
and allows no cleartext traffic at all; only a debug build also accepts plain
`http` for `localhost` and `127.0.0.1`, so it can reach a local server through
`adb reverse tcp:8787 tcp:8787`. The scanner is CameraX with ZXing rather than
a Google scanner, because those bundle usage reporting. Pairing again, even with
the same code, lifts a block that came from the server refusing the old pairing.

## How it syncs

WorkManager runs a sync every 15 minutes (any network, battery not low; a
**Upload on Wi-Fi only** switch narrows it to unmetered networks), and **Sync
now**, opening the app and the Tasker action run one at once. A sync reads each
granted record type's Health Connect change feed and uploads the changes in
gzip-compressed JSON batches to `POST /ingest/health-connect`; a cursor advances
only after the server answers 200. **Full backfill** (a button, not automatic)
runs a foreground service of type `health` that reads all history, newest UTC
month first, resumably; it can always be run again (**Run full backfill again**,
after a confirmation), and while it waits out an error it says so and resumes at
once when a lost connection returns. Months with no record of a type are skipped
with one request, pages are sized by what their records weigh, and the service
holds a wake lock (with a timeout) while it works so it keeps going with the
screen off. Being told to slow down, by Health Connect's rate limit or the
server's 429, is waited out by the backfill and the periodic sync alike and is
not counted as a failed run. It also uploads Health Connect's own hourly
totals for nine metrics as `Agg.<Metric>` records; a re-run also deletes the
totals of hours that no longer have one, and the hours the server says hold a
stale total (a deleted record's, which Health Connect dates nowhere) are worked
out again over the next syncs. A record too large to send even
alone does not block its type: it is uploaded as an envelope-only stub and counted
(`record_oversize_stubbed`). A 401 stops uploads until the phone is paired again,
and three failed runs in a row post a notification. The details, including every
error code, are in [docs/setup-android.md](../docs/setup-android.md).

## Build and test

You need JDK 21 and the Android SDK (platform `android-37.2`). Point Gradle at
the SDK with `ANDROID_HOME`, or a gitignored `local.properties` next to this
file containing `sdk.dir=<path>`. There is no global Gradle; use the wrapper.

```sh
cd android
./gradlew testDebugUnitTest   # JVM unit tests
./gradlew lintDebug           # Android lint; errors fail the build
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease     # minified; unsigned unless the variables below are set
```

On Windows use `gradlew.bat`, with `JAVA_HOME` pointing at the JDK.

`npm run check` at the repository root does not run Gradle. CI runs the three
debug tasks above in its own `android` job.

`PhoneBatchFixtureTest` writes the wire contract the Worker's tests also read,
`worker/test/fixtures/hc/phone-batches.json`, and fails when the checked-in copy is
stale. After an intended change to what the app sends, regenerate it with
`HEALTHY_WRITE_FIXTURES=1 ./gradlew testDebugUnitTest` and commit the file.

## Versions

`VERSION` holds `major.minor`. The patch number is the repository's commit
count (`git rev-list --count HEAD`, or `HEALTHY_PATCH` when set), so
`versionName` is `major.minor.patch` and
`versionCode = major * 1_000_000 + minor * 10_000 + patch`. Every push to
`main` therefore produces a newer version than the last. The code gives the minor
two digits and the patch four, so the build fails rather than produce a code that
could collide: a minor above 99 or a patch above 9999 is refused.

## Signing and releases

A release build is signed (with the v2 and v3 schemes; v3 lets the key be rotated
later) only when `HEALTHY_KEYSTORE_PATH` is set:

| Variable                    | Meaning                         |
| --------------------------- | ------------------------------- |
| `HEALTHY_KEYSTORE_PATH`     | Path to the release keystore    |
| `HEALTHY_KEYSTORE_PASSWORD` | Keystore password               |
| `HEALTHY_KEY_ALIAS`         | Alias of the signing key        |
| `HEALTHY_KEY_PASSWORD`      | Password of the signing key     |
| `HEALTHY_PATCH`             | Overrides the patch number (CI) |

`.github/workflows/release.yml` accepts the Android SDK licences, runs the unit
tests and lint, then builds, signs and publishes a release for every `main` commit that is
not already tagged `v*` (it also runs daily and on demand). It reads the keystore
from the repository secrets `KEYSTORE_BASE64` (the keystore file, base64-encoded),
`KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`, and fails at once, naming
`KEYSTORE_BASE64`, when that secret is missing. A keystore is never
committed: `*.jks` and `*.keystore` are gitignored. An update only installs
over an existing copy when it is signed with the same key, so keep the keystore
and its passwords somewhere safe.

## Layout

| Package      | What it holds                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.hc`        | The registry of record types and the Health Connect permission state                                                                               |
| `.hc.mapper` | `RecordSerializer`: one Health Connect record to one wire JSON object                                                                              |
| `.sync`      | Pairing and its encrypted store, the sync engine, batching, uploads, backfill service, WorkManager schedule, and the `SyncController` the UI calls |
| `.pair`      | QR scanning (CameraX frames decoded on the device with ZXing)                                                                                      |
| `.tasker`    | The Tasker plugin: one action, **Trigger refresh**                                                                                                 |
| `.ui`        | Compose screens: status, pairing, and the permissions rationale                                                                                    |

`RecordTypes.ALL` is the single list of record types. A unit test compares it
with the classes in the Health Connect client library and with the manifest's
`READ_*` permissions, so a library upgrade that adds a type fails the build
until the type is listed and its permission declared.
