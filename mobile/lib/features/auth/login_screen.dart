import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:tamerclaw_mobile/core/api/api_client.dart';
import 'package:tamerclaw_mobile/core/storage/secure_storage.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _serverUrlController = TextEditingController();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _obscurePassword = true;
  bool _rememberMe = true;
  _ConnectionStatus _connectionStatus = _ConnectionStatus.unknown;
  Timer? _healthTimer;
  bool _biometricTriggered = false;

  @override
  void initState() {
    super.initState();
    _loadSavedData();
  }

  Future<void> _loadSavedData() async {
    final storage = ref.read(secureStorageProvider);
    final creds = await storage.getCredentials();
    if (creds != null) {
      _serverUrlController.text = creds.serverUrl;
      _usernameController.text = creds.username;
      _checkConnection();
    } else {
      final savedUrl = await storage.getSavedServerUrl();
      if (savedUrl != null && savedUrl.isNotEmpty) {
        _serverUrlController.text = savedUrl;
      } else {
        _serverUrlController.text = 'http://203.161.35.95:19789';
      }
      _checkConnection();
    }
  }

  Future<void> _checkConnection() async {
    final url = _serverUrlController.text.trim();
    if (url.isEmpty || url == 'http://') {
      setState(() => _connectionStatus = _ConnectionStatus.unknown);
      return;
    }

    setState(() => _connectionStatus = _ConnectionStatus.checking);

    final ok = await ApiClient.checkHealth(url);
    if (mounted) {
      setState(() => _connectionStatus =
          ok ? _ConnectionStatus.connected : _ConnectionStatus.failed);
    }
  }

  @override
  void dispose() {
    _serverUrlController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    _healthTimer?.cancel();
    super.dispose();
  }

  Future<void> _handleLogin() async {
    if (!_formKey.currentState!.validate()) return;

    try {
      await ref.read(authProvider.notifier).login(
            serverUrl: _serverUrlController.text.trim(),
            username: _usernameController.text.trim(),
            password: _passwordController.text,
            rememberMe: _rememberMe,
          );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString()),
            backgroundColor: AppColors.error,
          ),
        );
      }
    }
  }

  Future<void> _handleBiometricLogin() async {
    try {
      await ref.read(authProvider.notifier).loginWithBiometric();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString()),
            backgroundColor: AppColors.error,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);

    // Auto-trigger biometric prompt once when awaiting biometric.
    if (authState.awaitingBiometric && !_biometricTriggered) {
      _biometricTriggered = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _handleBiometricLogin();
      });
    }

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Logo
                  Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      color: AppColors.accent.withOpacity(0.1),
                      borderRadius: BorderRadius.circular(18),
                    ),
                    child: const Icon(
                      Icons.hub_rounded,
                      size: 40,
                      color: AppColors.accent,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'TamerClaw',
                    style: TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 28,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Multi-Agent Control',
                    style: TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 40),

                  // Biometric quick-login button
                  if (authState.awaitingBiometric) ...[
                    _BiometricPromptButton(
                      isLoading: authState.isLoading,
                      onTap: _handleBiometricLogin,
                    ),
                    const SizedBox(height: 24),
                    const Row(
                      children: [
                        Expanded(child: Divider(color: AppColors.surfaceLight)),
                        Padding(
                          padding: EdgeInsets.symmetric(horizontal: 16),
                          child: Text(
                            'or sign in manually',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                            ),
                          ),
                        ),
                        Expanded(child: Divider(color: AppColors.surfaceLight)),
                      ],
                    ),
                    const SizedBox(height: 24),
                  ],

                  // Server URL with connection indicator
                  TextFormField(
                    controller: _serverUrlController,
                    style: const TextStyle(color: AppColors.textPrimary),
                    keyboardType: TextInputType.url,
                    decoration: InputDecoration(
                      hintText: 'Server URL',
                      prefixIcon: const Icon(Icons.dns_outlined,
                          color: AppColors.textSecondary),
                      suffixIcon: _buildConnectionIndicator(),
                    ),
                    validator: (value) {
                      if (value == null ||
                          value.trim().isEmpty ||
                          value.trim() == 'http://') {
                        return 'Enter server URL';
                      }
                      return null;
                    },
                    onChanged: (_) {
                      _healthTimer?.cancel();
                      _healthTimer = Timer(
                        const Duration(milliseconds: 800),
                        _checkConnection,
                      );
                    },
                  ),
                  const SizedBox(height: 16),

                  // Username
                  TextFormField(
                    controller: _usernameController,
                    style: const TextStyle(color: AppColors.textPrimary),
                    decoration: const InputDecoration(
                      hintText: 'Username',
                      prefixIcon:
                          Icon(Icons.person_outline, color: AppColors.textSecondary),
                    ),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) {
                        return 'Enter username';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 16),

                  // Password
                  TextFormField(
                    controller: _passwordController,
                    style: const TextStyle(color: AppColors.textPrimary),
                    obscureText: _obscurePassword,
                    decoration: InputDecoration(
                      hintText: 'Password',
                      prefixIcon: const Icon(Icons.lock_outline,
                          color: AppColors.textSecondary),
                      suffixIcon: IconButton(
                        icon: Icon(
                          _obscurePassword
                              ? Icons.visibility_off
                              : Icons.visibility,
                          color: AppColors.textSecondary,
                        ),
                        onPressed: () =>
                            setState(() => _obscurePassword = !_obscurePassword),
                      ),
                    ),
                    validator: (value) {
                      if (value == null || value.isEmpty) {
                        return 'Enter password';
                      }
                      return null;
                    },
                    onFieldSubmitted: (_) => _handleLogin(),
                  ),
                  const SizedBox(height: 12),

                  // Remember me
                  Row(
                    children: [
                      SizedBox(
                        height: 24,
                        width: 24,
                        child: Checkbox(
                          value: _rememberMe,
                          onChanged: (v) =>
                              setState(() => _rememberMe = v ?? true),
                          activeColor: AppColors.accent,
                          side: const BorderSide(color: AppColors.textSecondary),
                        ),
                      ),
                      const SizedBox(width: 8),
                      GestureDetector(
                        onTap: () =>
                            setState(() => _rememberMe = !_rememberMe),
                        child: const Text(
                          'Remember me',
                          style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),

                  // Login button
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: authState.isLoading ? null : _handleLogin,
                      child: authState.isLoading
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Text('Connect'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildConnectionIndicator() {
    switch (_connectionStatus) {
      case _ConnectionStatus.unknown:
        return const SizedBox.shrink();
      case _ConnectionStatus.checking:
        return const Padding(
          padding: EdgeInsets.all(12),
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        );
      case _ConnectionStatus.connected:
        return const Padding(
          padding: EdgeInsets.all(12),
          child: Icon(Icons.check_circle, color: AppColors.online, size: 20),
        );
      case _ConnectionStatus.failed:
        return const Padding(
          padding: EdgeInsets.all(12),
          child: Icon(Icons.error_outline, color: AppColors.error, size: 20),
        );
    }
  }
}

enum _ConnectionStatus { unknown, checking, connected, failed }

// ---------- Biometric prompt button ----------

class _BiometricPromptButton extends StatelessWidget {
  final bool isLoading;
  final VoidCallback onTap;

  const _BiometricPromptButton({
    required this.isLoading,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: isLoading ? null : onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 32),
        decoration: BoxDecoration(
          color: AppColors.accent.withOpacity(0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: AppColors.accent.withOpacity(0.25),
            width: 1,
          ),
        ),
        child: Column(
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: AppColors.accent.withOpacity(0.15),
                shape: BoxShape.circle,
              ),
              child: isLoading
                  ? const Padding(
                      padding: EdgeInsets.all(18),
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: AppColors.accent,
                      ),
                    )
                  : const Icon(
                      Icons.fingerprint,
                      size: 36,
                      color: AppColors.accent,
                    ),
            ),
            const SizedBox(height: 12),
            Text(
              isLoading ? 'Authenticating...' : 'Tap to unlock',
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontSize: 15,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 4),
            const Text(
              'Use biometrics to sign in',
              style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
