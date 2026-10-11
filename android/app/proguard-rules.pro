# Health Connect records are also read through reflection: the fallback serializer walks the
# public getters of any Record class that has no hand-written mapper (a type a newer library
# adds), and names the wire `type` after the class. Keep the classes, their public members and
# their names, together with the unit and metadata types those getters return.
-keep class androidx.health.connect.client.records.** { public *; }
-keep class androidx.health.connect.client.records.metadata.** { public *; }
-keep class androidx.health.connect.client.units.** { public *; }
-keepnames class androidx.health.connect.client.records.**
-keepnames class androidx.health.connect.client.units.**

# kotlinx.serialization. The library ships its own consumer rules for @Serializable classes;
# these restate the part that covers this app's own classes (serializers reached through a
# Companion or an object), so the release build does not depend on a transitive rule file.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault,InnerClasses
-if @kotlinx.serialization.Serializable class dev.maxhogan.healthy.companion.**
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}
-if @kotlinx.serialization.Serializable class dev.maxhogan.healthy.companion.** {
    static **$* *;
}
-keepclassmembers class <2>$<3> {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class dev.maxhogan.healthy.companion.** {
    public static ** INSTANCE;
}
-keepclassmembers class <1> {
    public static <1> INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep component names stable so adb commands and intents written against them keep working.
-keep class dev.maxhogan.healthy.companion.** extends android.app.Service
-keep class dev.maxhogan.healthy.companion.** extends android.content.BroadcastReceiver
