import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import 'package:tamerclaw_mobile/core/api/api_client.dart';
import 'package:tamerclaw_mobile/core/notifications/background_poll_service.dart';
import 'package:tamerclaw_mobile/core/storage/secure_storage.dart';

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(ref.read(secureStorageProvider));
});

final apiClientProvider = Provider<ApiClient?>((ref) {
  final auth = ref.watch(authProvider);
  if (auth.isAuthenticated) {
    final client = ApiClient(baseUrl: auth.serverUrl!, token: auth.token!);
    // Auto-refresh token on 401 using saved credentials
    client.onTokenRefresh = () async {
      try {
        final notifier = ref.read(authProvider.notifier);
        final newToken = await notifier.refreshToken();
        return newToken;
      } catch (_) {
        return null;
      }
    };
    return client;
  }
  return null;
});

class AuthState {
  final String? serverUrl;
  final String? token;
  final String? username;
  final bool isLoading;
  final bool isInitialized;
  final bool awaitingBiometric;
  final bool biometricEnabled;
  /// Saved credentials available for pre-filling the login form.
  final SavedCredentials? savedCredentials;

  const AuthState({
    this.serverUrl,
    this.token,
    this.username,
    this.isLoading = false,
    this.isInitialized = false,
    this.awaitingBiometric = false,
    this.biometricEnabled = false,
    this.savedCredentials,
  });

  bool get isAuthenticated => token != null && serverUrl != null;

  AuthState copyWith({
    String? serverUrl,
    String? token,
    String? username,
    bool? isLoading,
    bool? isInitialized,
    bool? awaitingBiometric,
    bool? biometricEnabled,
    SavedCredentials? savedCredentials,
  }) {
    return AuthState(
      serverUrl: serverUrl ?? this.serverUrl,
      token: token ?? this.token,
      username: username ?? this.username,
      isLoading: isLoading ?? this.isLoading,
      isInitialized: isInitialized ?? this.isInitialized,
      awaitingBiometric: awaitingBiometric ?? this.awaitingBiometric,
      biometricEnabled: biometricEnabled ?? this.biometricEnabled,
      savedCredentials: savedCredentials ?? this.savedCredentials,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthState> {
  final SecureStorageService _storage;
  final LocalAuthentication _localAuth = LocalAuthentication();

  AuthNotifier(this._storage) : super(const AuthState()) {
    _tryAutoLogin();
  }

  Future<void> _tryAutoLogin() async {
    final creds = await _storage.getCredentials();
    final biometricOn = await _storage.isBiometricEnabled();

    if (creds != null && creds.rememberMe) {
      if (biometricOn) {
        // Don't auto-login yet -- wait for biometric verification.
        state = AuthState(
          isInitialized: true,
          awaitingBiometric: true,
          biometricEnabled: true,
          savedCredentials: creds,
        );
      } else {
        // Normal auto-login with saved credentials.
        state = AuthState(
          serverUrl: creds.serverUrl,
          token: creds.token,
          username: creds.username,
          isInitialized: true,
          biometricEnabled: false,
        );
        BackgroundPollService.saveCredentialsForBackground(
          serverUrl: creds.serverUrl,
          token: creds.token,
        );
      }
    } else {
      state = AuthState(
        isInitialized: true,
        savedCredentials: creds,
      );
    }
  }

  /// Authenticate using device biometrics and then log in with saved credentials.
  Future<void> loginWithBiometric() async {
    final creds = state.savedCredentials ?? await _storage.getCredentials();
    if (creds == null) {
      throw const ApiException('No saved credentials found.');
    }

    state = state.copyWith(isLoading: true);

    try {
      // Check biometric availability first.
      final canAuth = await _localAuth.canCheckBiometrics ||
          await _localAuth.isDeviceSupported();
      if (!canAuth) {
        // Fall back to password login with saved credentials if biometric
        // hardware is not available (e.g. emulator).
        debugPrint('[Biometric] Not available, falling back to saved creds');
        state = AuthState(
          serverUrl: creds.serverUrl,
          token: creds.token,
          username: creds.username,
          isInitialized: true,
          biometricEnabled: false,
        );
        // Disable biometric since hardware is gone.
        await _storage.setBiometricEnabled(false);
        await BackgroundPollService.saveCredentialsForBackground(
          serverUrl: creds.serverUrl,
          token: creds.token,
        );
        return;
      }

      final didAuthenticate = await _localAuth.authenticate(
        localizedReason: 'Authenticate to access TamerClaw',
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: false,
        ),
      );

      if (!didAuthenticate) {
        state = state.copyWith(isLoading: false);
        return;
      }

      // Try to re-login for a fresh token. If server is unreachable,
      // fall back to the cached token.
      try {
        final result = await ApiClient.login(
          serverUrl: creds.serverUrl,
          username: creds.username,
          password: creds.password,
        );

        final token = result['token'] as String?;
        if (token == null) {
          throw const ApiException('Server did not return a token.');
        }

        await _storage.saveCredentials(
          serverUrl: creds.serverUrl,
          username: creds.username,
          password: creds.password,
          token: token,
          rememberMe: true,
        );

        state = AuthState(
          serverUrl: creds.serverUrl,
          token: token,
          username: creds.username,
          isInitialized: true,
          biometricEnabled: true,
        );
        await BackgroundPollService.saveCredentialsForBackground(
          serverUrl: creds.serverUrl,
          token: token,
        );
      } on ApiException catch (e) {
        // If server is unreachable, use cached token.
        if (e.message.contains('connect') ||
            e.message.contains('timed out') ||
            e.message.contains('network')) {
          debugPrint('[Biometric] Server unreachable, using cached token');
          state = AuthState(
            serverUrl: creds.serverUrl,
            token: creds.token,
            username: creds.username,
            isInitialized: true,
            biometricEnabled: true,
          );
          await BackgroundPollService.saveCredentialsForBackground(
            serverUrl: creds.serverUrl,
            token: creds.token,
          );
        } else {
          rethrow;
        }
      }
    } catch (e) {
      state = state.copyWith(isLoading: false);
      rethrow;
    }
  }

  /// Silently re-login using saved credentials and return the new token.
  Future<String?> refreshToken() async {
    final creds = await _storage.getCredentials();
    if (creds == null) return null;

    try {
      final result = await ApiClient.login(
        serverUrl: creds.serverUrl,
        username: creds.username,
        password: creds.password,
      );
      final newToken = result['token'] as String?;
      if (newToken != null) {
        await _storage.saveCredentials(
          serverUrl: creds.serverUrl,
          username: creds.username,
          password: creds.password,
          token: newToken,
          rememberMe: true,
        );
        state = state.copyWith(token: newToken);
        await BackgroundPollService.saveCredentialsForBackground(
          serverUrl: creds.serverUrl,
          token: newToken,
        );
      }
      return newToken;
    } catch (e) {
      debugPrint('[Auth] Token refresh failed: $e');
      return null;
    }
  }

  Future<void> login({
    required String serverUrl,
    required String username,
    required String password,
    bool rememberMe = true,
  }) async {
    state = state.copyWith(isLoading: true);

    try {
      final result = await ApiClient.login(
        serverUrl: serverUrl,
        username: username,
        password: password,
      );

      final token = result['token'] as String?;
      if (token == null) {
        throw const ApiException('Server did not return a token.');
      }

      await _storage.saveCredentials(
        serverUrl: serverUrl,
        username: username,
        password: password,
        token: token,
        rememberMe: rememberMe,
      );

      state = AuthState(
        serverUrl: serverUrl,
        token: token,
        username: username,
        isInitialized: true,
        biometricEnabled: await _storage.isBiometricEnabled(),
      );

      await BackgroundPollService.saveCredentialsForBackground(
        serverUrl: serverUrl,
        token: token,
      );
    } catch (e) {
      state = state.copyWith(isLoading: false);
      rethrow;
    }
  }

  /// Enable biometric login. Call after a successful manual login.
  Future<bool> enableBiometric() async {
    try {
      final canCheck = await _localAuth.canCheckBiometrics;
      final isDeviceSupported = await _localAuth.isDeviceSupported();
      debugPrint('[Biometric] canCheck=$canCheck, isDeviceSupported=$isDeviceSupported');
      if (!canCheck && !isDeviceSupported) {
        debugPrint('[Biometric] No biometric hardware or not enrolled');
        return false;
      }

      final availableBiometrics = await _localAuth.getAvailableBiometrics();
      debugPrint('[Biometric] Available: $availableBiometrics');

      final didAuthenticate = await _localAuth.authenticate(
        localizedReason: 'Verify your identity to enable biometric login',
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: false,
        ),
      );

      if (didAuthenticate) {
        await _storage.setBiometricEnabled(true);
        state = state.copyWith(biometricEnabled: true);
        return true;
      }
      debugPrint('[Biometric] Authentication returned false');
      return false;
    } catch (e) {
      debugPrint('[Biometric] Error enabling: $e');
      return false;
    }
  }

  Future<void> disableBiometric() async {
    await _storage.setBiometricEnabled(false);
    state = state.copyWith(biometricEnabled: false);
  }

  /// Check whether biometric hardware is available on this device.
  Future<bool> isBiometricAvailable() async {
    try {
      final canCheck = await _localAuth.canCheckBiometrics;
      final isDeviceSupported = await _localAuth.isDeviceSupported();
      return canCheck || isDeviceSupported;
    } catch (_) {
      return false;
    }
  }

  Future<void> logout() async {
    await _storage.clearAll();
    await BackgroundPollService.clearCredentials();
    await BackgroundPollService.cancelAll();
    state = const AuthState(isInitialized: true);
  }
}
