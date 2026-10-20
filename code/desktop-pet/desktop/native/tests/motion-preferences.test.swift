// Pure-Foundation checks for the motion preference helper. Run with:
//   swiftc -o /tmp/motion-prefs-test desktop/native/motion-preferences.swift \
//     desktop/native/tests/motion-preferences.test.swift desktop/native/tests/main.swift && /tmp/motion-prefs-test
//
// The body lives in a function because swiftc only allows top-level expressions in a file named
// main.swift; the runner beside this file is that entry point.
import Foundation

func runMotionPreferencesTests() -> Int {
var failures = 0
func check(_ condition: Bool, _ message: String) {
	if !condition { failures += 1; print("FAIL: \(message)") } else { print("ok  : \(message)") }
}

// Defaults
let base = MotionSettings.normalize(nil)
check(base == MotionSettings.default, "missing settings fall back to the documented defaults")
check(base.amount == 0.6 && base.speed == 0.75 && base.frequency == 1.0 && base.tracking && base.rate == "60", "default values are 0.6 / 0.75 / 1 / true / 60")

// Clamping
let clamped = MotionSettings.normalize(["amount": 5.0, "speed": -3.0, "frequency": 9.0])
check(clamped.amount == 1.0, "amount clamps to 1")
check(clamped.speed == 0.2, "speed clamps to 0.2")
check(clamped.frequency == 2.0, "frequency clamps to 2")

// Corrupt values degrade rather than throw
let corrupt = MotionSettings.normalize(["amount": "abc", "speed": NSNull(), "frequency": Double.nan, "tracking": "maybe", "rate": "turbo"])
check(corrupt == MotionSettings.default, "corrupt values degrade to defaults, including an unknown rate")

// Strings from a JSON bridge or `defaults write`
let strings = MotionSettings.normalize(["amount": "0.25", "speed": "1.5", "frequency": "0", "tracking": "false", "rate": "high"])
check(strings.amount == 0.25 && strings.speed == 1.5 && strings.frequency == 0 && strings.tracking == false && strings.rate == "high", "string values are accepted and normalised")

// Non-finite numbers never survive
check(MotionSettings.normalize(["amount": Double.infinity]).amount == 0.6, "infinity is refused")

// Persistence round-trip in a throwaway suite
let suite = "local.aaaagent.motion-preferences.test.\(UUID().uuidString)"
let saved = MotionPreferences.save(MotionSettings(amount: 0.3, speed: 1.25, frequency: 1.5, tracking: false, rate: "eco"), suite: suite)
check(saved.amount == 0.3 && saved.tracking == false && saved.rate == "eco", "save normalises what it stores")
let loaded = MotionPreferences.load(suite: suite)
check(loaded == saved, "the saved settings load back unchanged")
check(MotionPreferences.load(suite: "local.aaaagent.motion-preferences.test.\(UUID().uuidString)").amount == 0.6, "an unknown suite reads as defaults instead of throwing")
MotionPreferences.suite(suite).removePersistentDomain(forName: suite)
check(MotionPreferences.load(suite: suite) == MotionSettings.default, "a cleared suite reads as defaults")

// Behaviour list and validation
check(MotionBehaviour.all.count == 11, "eleven behaviours are offered")
check(MotionBehaviour.names == ["Idle", "Breathing", "Blink", "LookAt", "Talking", "Happy", "Surprised", "Shy", "Sleep", "Drag", "Interact"], "backend names are stable and ordered")
check(MotionBehaviour.label(for: "Talking") == "说话", "labels are the Chinese shown to the user")
check(MotionBehaviour.label(for: "Nonexistent") == "待机", "an unknown behaviour falls back to 待机")
let animSuite = "local.aaaagent.motion-preferences.test.\(UUID().uuidString)"
check(MotionPreferences.saveAnimation("Shy", suite: animSuite) == "Shy", "a known behaviour is stored")
check(MotionPreferences.loadAnimation(suite: animSuite) == "Shy", "and loads back")
check(MotionPreferences.saveAnimation("Bogus", suite: animSuite) == "Idle", "an unknown behaviour degrades to Idle")
MotionPreferences.suite(animSuite).removePersistentDomain(forName: animSuite)

print(failures == 0 ? "ALL PASS" : "FAILURES: \(failures)")
return failures == 0 ? 0 : 1
}
