#!/bin/bash
# Runs inside the CI emulator: the app against the console simulator, then against the PC hub.
# The host machine is 10.0.2.2 from inside the emulator.
set -x
OUT=e2e
mkdir -p $OUT
adb install -r NXBeam-Android.apk
adb logcat -c

shot() { adb exec-out screencap -p > "$OUT/$1.png"; }

# 1. straight to the "console" over Wi-Fi
adb shell am start -W -a android.intent.action.VIEW -d "nxbeam://wifi/10.0.2.2:9950"
sleep 20
shot direct
# record a few seconds
adb shell input keyevent KEYCODE_MEDIA_RECORD
sleep 8
adb shell input keyevent KEYCODE_MEDIA_RECORD
sleep 4
shot direct-after-record
adb shell ls -la /sdcard/Movies/NXBeam/ > $OUT/movies.txt 2>&1
f=$(adb shell ls /sdcard/Movies/NXBeam/ 2>/dev/null | tr -d '\r' | head -1)
[ -n "$f" ] && adb pull "/sdcard/Movies/NXBeam/$f" $OUT/recording.mp4
adb logcat -d > $OUT/logcat-direct.txt
adb logcat -d -s NXBeam > $OUT/stats-direct.txt
adb shell am force-stop com.harisdevlab.nxbeam
sleep 3

# 2. through NXBeam on the "PC"
nohup node src/index.js --no-open --port 8090 --mode network --console 127.0.0.1 > $OUT/hub.log 2>&1 &
sleep 8
adb logcat -c
adb shell am start -W -a android.intent.action.VIEW -d "nxbeam://hub/10.0.2.2:8090"
sleep 20
shot hub
adb logcat -d > $OUT/logcat-hub.txt
adb logcat -d -s NXBeam > $OUT/stats-hub.txt
adb shell am force-stop com.harisdevlab.nxbeam

# 3. the home screen
adb shell am start -W -n com.harisdevlab.nxbeam/.MainActivity
sleep 6
shot home
exit 0
