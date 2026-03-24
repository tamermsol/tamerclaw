import 'dart:convert';

/// Stores local customizations for an agent: favorite status, custom name, and icon.
class AgentCustomization {
  final bool isFavorite;
  final String? customName;

  /// Icon codePoint from the Material Icons font family.
  final int? iconCodePoint;

  /// Icon font family (e.g. 'MaterialIcons').
  final String? iconFontFamily;

  const AgentCustomization({
    this.isFavorite = false,
    this.customName,
    this.iconCodePoint,
    this.iconFontFamily,
  });

  AgentCustomization copyWith({
    bool? isFavorite,
    String? customName,
    int? iconCodePoint,
    String? iconFontFamily,
    bool clearCustomName = false,
    bool clearIcon = false,
  }) {
    return AgentCustomization(
      isFavorite: isFavorite ?? this.isFavorite,
      customName: clearCustomName ? null : (customName ?? this.customName),
      iconCodePoint: clearIcon ? null : (iconCodePoint ?? this.iconCodePoint),
      iconFontFamily:
          clearIcon ? null : (iconFontFamily ?? this.iconFontFamily),
    );
  }

  Map<String, dynamic> toJson() => {
        'isFavorite': isFavorite,
        if (customName != null) 'customName': customName,
        if (iconCodePoint != null) 'iconCodePoint': iconCodePoint,
        if (iconFontFamily != null) 'iconFontFamily': iconFontFamily,
      };

  factory AgentCustomization.fromJson(Map<String, dynamic> json) {
    return AgentCustomization(
      isFavorite: json['isFavorite'] as bool? ?? false,
      customName: json['customName'] as String?,
      iconCodePoint: json['iconCodePoint'] as int?,
      iconFontFamily: json['iconFontFamily'] as String?,
    );
  }

  /// Encode a full map of agent ID -> customization to a JSON string.
  static String encodeMap(Map<String, AgentCustomization> map) {
    final jsonMap = map.map((k, v) => MapEntry(k, v.toJson()));
    return jsonEncode(jsonMap);
  }

  /// Decode a JSON string back to a map of agent ID -> customization.
  static Map<String, AgentCustomization> decodeMap(String jsonStr) {
    if (jsonStr.isEmpty) return {};
    try {
      final decoded = jsonDecode(jsonStr) as Map<String, dynamic>;
      return decoded.map(
        (k, v) => MapEntry(
          k,
          AgentCustomization.fromJson(v as Map<String, dynamic>),
        ),
      );
    } catch (_) {
      return {};
    }
  }
}
