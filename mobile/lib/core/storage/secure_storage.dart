import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

final secureStorageProvider = Provider<SecureStorageService>((ref) {
  return SecureStorageService();
});

class SecureStorageService {
  static const _keyServerUrl = 'server_url';
  static const _keyUsername = 'username';
  static const _keyPassword = 'password';
  static const _keyToken = 'auth_token';
  static const _keyRememberMe = 'remember_me';
  static const _keyRecentAgents = 'recent_agents';
  static const _keyBiometricEnabled = 'biometric_enabled';

  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );

  // --- Auth credentials ---

  Future<void> saveCredentials({
    required String serverUrl,
    required String username,
    required String password,
    required String token,
    bool rememberMe = true,
  }) async {
    await Future.wait([
      _storage.write(key: _keyServerUrl, value: serverUrl),
      _storage.write(key: _keyUsername, value: username),
      _storage.write(key: _keyPassword, value: password),
      _storage.write(key: _keyToken, value: token),
      _storage.write(key: _keyRememberMe, value: rememberMe.toString()),
    ]);
  }

  Future<SavedCredentials?> getCredentials() async {
    final results = await Future.wait([
      _storage.read(key: _keyServerUrl),
      _storage.read(key: _keyUsername),
      _storage.read(key: _keyPassword),
      _storage.read(key: _keyToken),
      _storage.read(key: _keyRememberMe),
    ]);

    final serverUrl = results[0];
    final username = results[1];
    final password = results[2];
    final token = results[3];
    final rememberMe = results[4];

    if (serverUrl != null && username != null && password != null && token != null) {
      return SavedCredentials(
        serverUrl: serverUrl,
        username: username,
        password: password,
        token: token,
        rememberMe: rememberMe != 'false',
      );
    }
    return null;
  }

  Future<String?> getSavedServerUrl() async {
    return _storage.read(key: _keyServerUrl);
  }

  Future<void> clearAll() async {
    await _storage.deleteAll();
  }

  // --- Biometric ---

  Future<bool> isBiometricEnabled() async {
    final value = await _storage.read(key: _keyBiometricEnabled);
    return value == 'true';
  }

  Future<void> setBiometricEnabled(bool enabled) async {
    await _storage.write(key: _keyBiometricEnabled, value: enabled.toString());
  }

  // --- Recent agents ---

  Future<List<String>> getRecentAgents() async {
    final raw = await _storage.read(key: _keyRecentAgents);
    if (raw == null || raw.isEmpty) return [];
    return raw.split(',').where((s) => s.isNotEmpty).toList();
  }

  Future<void> addRecentAgent(String agentId) async {
    final recent = await getRecentAgents();
    recent.remove(agentId);
    recent.insert(0, agentId);
    // Keep only the last 10
    final trimmed = recent.take(10).toList();
    await _storage.write(key: _keyRecentAgents, value: trimmed.join(','));
  }
}

class SavedCredentials {
  final String serverUrl;
  final String username;
  final String password;
  final String token;
  final bool rememberMe;

  const SavedCredentials({
    required this.serverUrl,
    required this.username,
    required this.password,
    required this.token,
    this.rememberMe = true,
  });
}
