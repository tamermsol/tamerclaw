# Flutter-specific ProGuard rules
-keep class io.flutter.app.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.util.** { *; }
-keep class io.flutter.view.** { *; }
-keep class io.flutter.** { *; }
-keep class io.flutter.plugins.** { *; }

# Keep annotations
-keepattributes *Annotation*

# Audioplayers
-keep class xyz.luan.audioplayers.** { *; }

# Record (voice recording)
-keep class com.llfbandit.record.** { *; }

# Dio / OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }

# Local Auth (biometrics)
-keep class androidx.biometric.** { *; }

# Flutter Local Notifications
-keep class com.dexterous.** { *; }

# WorkManager
-keep class androidx.work.** { *; }
