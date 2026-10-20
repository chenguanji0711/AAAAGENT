// Motion preferences for the native window.
//
// Pure Foundation on purpose: the settings must be testable without a running app, and they must
// live in a named suite rather than the system-wide domain, so a development build cannot leak
// values into every other app that shares the user's defaults.
//
// Every field is normalised on the way in and on the way out. A corrupt, missing or hand-edited
// value degrades to the documented default instead of throwing or leaving the pet in a state the
// UI cannot represent.

import Foundation

/// The five knobs the renderer consumes. Mirrors `normalizeMotionSettings` on the JavaScript side.
public struct MotionSettings: Equatable {
	public var amount: Double
	public var speed: Double
	public var frequency: Double
	public var tracking: Bool
	public var rate: String

	public static let defaultAmount = 0.6
	public static let defaultSpeed = 0.75
	public static let defaultFrequency = 1.0
	public static let defaultRate = "60"

	public static let amountRange = 0.0...1.0
	public static let speedRange = 0.2...2.0
	public static let frequencyRange = 0.0...2.0
	public static let rates = ["60", "high", "eco"]

	public init(amount: Double = defaultAmount, speed: Double = defaultSpeed,
	            frequency: Double = defaultFrequency, tracking: Bool = true,
	            rate: String = defaultRate) {
		self.amount = amount
		self.speed = speed
		self.frequency = frequency
		self.tracking = tracking
		self.rate = rate
	}

	public static let `default` = MotionSettings()

	/// Clamps into `range`, replacing anything non-finite or missing with `fallback`.
	static func clamp(_ raw: Any?, _ range: ClosedRange<Double>, _ fallback: Double) -> Double {
		guard let number = asDouble(raw), number.isFinite else { return fallback }
		return Swift.min(range.upperBound, Swift.max(range.lowerBound, number))
	}

	/// Accepts numbers and the strings a JSON bridge or `defaults write` may hand over.
	static func asDouble(_ raw: Any?) -> Double? {
		switch raw {
		case let value as Double: return value
		case let value as Int: return Double(value)
		case let value as NSNumber: return value.doubleValue
		case let value as String: return Double(value)
		default: return nil
		}
	}

	/// Strict normalisation: unknown rates fall back, booleans keep their meaning only when real.
	public static func normalize(_ raw: [String: Any]?) -> MotionSettings {
		let source = raw ?? [:]
		let tracking: Bool
		if let value = source["tracking"] as? Bool {
			tracking = value
		} else if let value = source["tracking"] as? NSNumber {
			tracking = value.boolValue
		} else if let value = source["tracking"] as? String {
			// Only the two documented spellings count; anything else keeps the default.
			let lowered = value.lowercased()
			tracking = lowered == "true" ? true : (lowered == "false" ? false : true)
		} else {
			tracking = true
		}
		let rate = (source["rate"] as? String).flatMap { rates.contains($0) ? $0 : nil } ?? defaultRate
		return MotionSettings(
			amount: clamp(source["amount"], amountRange, defaultAmount),
			speed: clamp(source["speed"], speedRange, defaultSpeed),
			frequency: clamp(source["frequency"], frequencyRange, defaultFrequency),
			tracking: tracking,
			rate: rate)
	}

	public var dictionary: [String: Any] {
		["amount": amount, "speed": speed, "frequency": frequency, "tracking": tracking, "rate": rate]
	}
}

/// The behaviours the settings window offers, keyed by the stable backend name.
public enum MotionBehaviour {
	public static let all: [(name: String, label: String)] = [
		("Idle", "待机"), ("Breathing", "呼吸"), ("Blink", "眨眼"), ("LookAt", "注视"),
		("Talking", "说话"), ("Happy", "开心"), ("Surprised", "惊讶"), ("Shy", "害羞"),
		("Sleep", "睡觉"), ("Drag", "拖动"), ("Interact", "互动"),
	]
	public static let names = all.map(\.name)
	public static func label(for name: String) -> String {
		all.first { $0.name == name }?.label ?? "待机"
	}
}

/// UserDefaults access confined to one suite.
public enum MotionPreferences {
	/// A dedicated suite, never `.standard`: the development build must not write into the
	/// system-wide domain that every other app on the machine reads.
	public static let suiteName = "local.aaaagent.motion-preferences"
	static let settingsKey = "motionSettings"
	static let animationKey = "selectedAnimation"

	public static func suite(_ name: String = suiteName) -> UserDefaults {
		UserDefaults(suiteName: name) ?? UserDefaults.standard
	}

	public static func load(suite name: String = suiteName) -> MotionSettings {
		MotionSettings.normalize(suite(name).dictionary(forKey: settingsKey))
	}

	@discardableResult
	public static func save(_ settings: MotionSettings, suite name: String = suiteName) -> MotionSettings {
		let normalized = MotionSettings.normalize(settings.dictionary)
		suite(name).set(normalized.dictionary, forKey: settingsKey)
		return normalized
	}

	/// The chosen behaviour, validated against the known list so a stale value cannot be selected.
	public static func loadAnimation(suite name: String = suiteName) -> String {
		let stored = suite(name).string(forKey: animationKey) ?? "Idle"
		return MotionBehaviour.names.contains(stored) ? stored : "Idle"
	}

	@discardableResult
	public static func saveAnimation(_ name: String, suite suiteName: String = suiteName) -> String {
		let valid = MotionBehaviour.names.contains(name) ? name : "Idle"
		suite(suiteName).set(valid, forKey: animationKey)
		return valid
	}
}
