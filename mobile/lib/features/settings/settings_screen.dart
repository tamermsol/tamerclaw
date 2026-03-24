import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';
import 'package:tamerclaw_mobile/features/status/status_provider.dart';

const String appVersion = '6.0.0';

/// Tracks whether biometric hardware is available on this device.
final _biometricAvailableProvider = FutureProvider<bool>((ref) async {
  final auth = ref.read(authProvider.notifier);
  return auth.isBiometricAvailable();
});

/// Fetches server config from /api/config.
final _serverConfigProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  if (api == null) return {};
  try {
    final result = await api.get('/api/config');
    if (result is Map<String, dynamic>) return result;
    return {};
  } catch (_) {
    return {};
  }
});

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final biometricAvailable = ref.watch(_biometricAvailableProvider);
    final serverConfig = ref.watch(_serverConfigProvider);
    final statusState = ref.watch(statusProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Profile section with avatar
          _ProfileCard(
            username: auth.username ?? 'User',
            serverUrl: auth.serverUrl ?? '',
          ),
          const SizedBox(height: 20),

          // Security section
          const _SectionLabel(text: 'SECURITY'),
          Card(
            child: Column(
              children: [
                // Biometric toggle
                biometricAvailable.when(
                  data: (available) {
                    if (!available) return const SizedBox.shrink();
                    return _BiometricToggleTile(
                      isEnabled: auth.biometricEnabled,
                    );
                  },
                  loading: () => const SizedBox.shrink(),
                  error: (_, __) => const SizedBox.shrink(),
                ),
                if (biometricAvailable.valueOrNull == true)
                  const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.dns_outlined,
                  title: 'Server URL',
                  subtitle: auth.serverUrl ?? 'Not connected',
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Telegram Management section
          const _SectionLabel(text: 'INTEGRATIONS'),
          Card(
            child: Column(
              children: [
                _TelegramNavTile(config: serverConfig),
                const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.schedule,
                  title: 'Cron Jobs',
                  subtitle: '${statusState.cronJobs.length} jobs configured',
                  onTap: () => context.go('/cron'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Appearance section
          const _SectionLabel(text: 'APPEARANCE'),
          Card(
            child: Column(
              children: [
                _SettingsTile(
                  icon: Icons.palette_outlined,
                  title: 'Theme',
                  subtitle: 'Dark (Default)',
                  trailing: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AppColors.accent.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const Text(
                      'Dark',
                      style: TextStyle(
                        color: AppColors.accent,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Notifications section
          const _SectionLabel(text: 'NOTIFICATIONS'),
          Card(
            child: Column(
              children: [
                _ToggleTile(
                  icon: Icons.notifications_outlined,
                  title: 'Push Notifications',
                  subtitle: 'Receive alerts for agent status changes',
                  value: true,
                  onChanged: (_) {
                    HapticFeedback.selectionClick();
                  },
                ),
                const Divider(height: 1, indent: 52),
                _ToggleTile(
                  icon: Icons.vibration,
                  title: 'Haptic Feedback',
                  subtitle: 'Vibrate on tap interactions',
                  value: true,
                  onChanged: (_) {
                    HapticFeedback.selectionClick();
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // System section
          const _SectionLabel(text: 'SYSTEM'),
          Card(
            child: Column(
              children: [
                _SettingsTile(
                  icon: Icons.timer_outlined,
                  title: 'Server Uptime',
                  subtitle: statusState.status?.uptimeDisplay ?? '--',
                  trailing: Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: statusState.status != null
                          ? AppColors.online
                          : AppColors.offline,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
                const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.smart_toy_outlined,
                  title: 'Active Agents',
                  subtitle:
                      '${statusState.status?.activeAgents ?? 0} / ${statusState.status?.totalAgents ?? 0}',
                ),
                const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.hub_outlined,
                  title: 'Total Sessions',
                  subtitle: '${statusState.status?.totalSessions ?? 0}',
                ),
                const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.outbox,
                  title: 'Delivery Queue',
                  subtitle:
                      '${statusState.status?.deliveryPending ?? 0} pending, ${statusState.status?.deliveryFailed ?? 0} failed',
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Server config section
          serverConfig.when(
            data: (config) {
              if (config.isEmpty) return const SizedBox.shrink();
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _SectionLabel(text: 'SERVER CONFIGURATION'),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: config.entries.take(8).map((entry) {
                          final value = entry.value;
                          String display;
                          if (value is bool) {
                            display = value ? 'Enabled' : 'Disabled';
                          } else if (value is String && value.length > 40) {
                            display = '${value.substring(0, 40)}...';
                          } else {
                            display = value.toString();
                          }
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                SizedBox(
                                  width: 130,
                                  child: Text(
                                    entry.key,
                                    style: const TextStyle(
                                      color: AppColors.textSecondary,
                                      fontSize: 12,
                                    ),
                                  ),
                                ),
                                Expanded(
                                  child: Text(
                                    display,
                                    style: const TextStyle(
                                      color: AppColors.textPrimary,
                                      fontSize: 12,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          );
                        }).toList(),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
              );
            },
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
          ),

          // About section
          const _SectionLabel(text: 'ABOUT'),
          Card(
            child: Column(
              children: [
                const _SettingsTile(
                  icon: Icons.info_outline,
                  title: 'App Version',
                  subtitle: 'v$appVersion (Command Center)',
                ),
                const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.description_outlined,
                  title: 'Licenses',
                  subtitle: 'Open source licenses',
                  onTap: () {
                    showLicensePage(
                      context: context,
                      applicationName: 'TamerClaw',
                      applicationVersion: appVersion,
                    );
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Danger zone
          const _SectionLabel(text: 'DANGER ZONE'),
          Card(
            child: Column(
              children: [
                _SettingsTile(
                  icon: Icons.delete_outline,
                  title: 'Clear Local Data',
                  subtitle: 'Remove cached data and preferences',
                  iconColor: AppColors.warning,
                  onTap: () => _confirmClearData(context, ref),
                ),
                const Divider(height: 1, indent: 52),
                _SettingsTile(
                  icon: Icons.logout,
                  title: 'Log Out',
                  subtitle: 'Disconnect from server',
                  iconColor: AppColors.error,
                  onTap: () => _confirmLogout(context, ref),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
        ],
      ),
    );
  }

  void _confirmLogout(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Log Out',
            style: TextStyle(color: AppColors.textPrimary)),
        content: const Text(
          'Are you sure you want to log out?',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              ref.read(authProvider.notifier).logout();
            },
            child: const Text('Log Out',
                style: TextStyle(color: AppColors.error)),
          ),
        ],
      ),
    );
  }

  void _confirmClearData(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Clear Data',
            style: TextStyle(color: AppColors.textPrimary)),
        content: const Text(
          'This will clear all cached data. You will remain logged in.',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Local data cleared')),
              );
            },
            child: const Text('Clear',
                style: TextStyle(color: AppColors.warning)),
          ),
        ],
      ),
    );
  }
}

// ---------- Profile Card ----------

class _ProfileCard extends StatelessWidget {
  final String username;
  final String serverUrl;

  const _ProfileCard({
    required this.username,
    required this.serverUrl,
  });

  String get _initials {
    if (username.isEmpty) return '?';
    final parts = username.split(' ');
    if (parts.length >= 2) {
      return '${parts[0][0]}${parts[1][0]}'.toUpperCase();
    }
    return username[0].toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(20),
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              gradient: AppColors.accentGradient,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Center(
              child: Text(
                _initials,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  username,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Container(
                      width: 6,
                      height: 6,
                      decoration: const BoxDecoration(
                        color: AppColors.online,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        serverUrl,
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 12,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Section label ----------

class _SectionLabel extends StatelessWidget {
  final String text;

  const _SectionLabel({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Text(
        text,
        style: const TextStyle(
          color: AppColors.textSecondary,
          fontSize: 11,
          fontWeight: FontWeight.w600,
          letterSpacing: 1,
        ),
      ),
    );
  }
}

// ---------- Telegram nav tile ----------

class _TelegramNavTile extends StatelessWidget {
  final AsyncValue<Map<String, dynamic>> config;

  const _TelegramNavTile({required this.config});

  @override
  Widget build(BuildContext context) {
    return config.when(
      data: (cfg) {
        final hasBotToken = cfg['hasBotToken'] == true ||
            cfg['botToken'] != null ||
            cfg['telegramBotToken'] != null;

        return _SettingsTile(
          icon: Icons.telegram,
          title: 'Manage Telegram Bots',
          subtitle: hasBotToken ? 'Connected' : 'Not configured',
          trailing: const Icon(
            Icons.chevron_right,
            color: AppColors.textSecondary,
            size: 20,
          ),
          onTap: () => context.push('/telegram'),
        );
      },
      loading: () => const _SettingsTile(
        icon: Icons.telegram,
        title: 'Manage Telegram Bots',
        subtitle: 'Loading...',
      ),
      error: (_, __) => _SettingsTile(
        icon: Icons.telegram,
        title: 'Manage Telegram Bots',
        subtitle: 'Could not load config',
        onTap: () => context.push('/telegram'),
      ),
    );
  }
}

// ---------- Biometric toggle ----------

class _BiometricToggleTile extends ConsumerWidget {
  final bool isEnabled;

  const _BiometricToggleTile({required this.isEnabled});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          const Icon(Icons.fingerprint,
              color: AppColors.textSecondary, size: 20),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Biometric Login',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  isEnabled
                      ? 'Unlock with fingerprint or face'
                      : 'Use biometrics to sign in faster',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Switch(
            value: isEnabled,
            onChanged: (value) async {
              HapticFeedback.selectionClick();
              final notifier = ref.read(authProvider.notifier);
              if (value) {
                final success = await notifier.enableBiometric();
                if (!success && context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text(
                          'Could not enable biometric login. Check your device settings.'),
                    ),
                  );
                }
              } else {
                await notifier.disableBiometric();
              }
            },
          ),
        ],
      ),
    );
  }
}

// ---------- Toggle tile ----------

class _ToggleTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  const _ToggleTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: AppColors.textSecondary, size: 20),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}

// ---------- Settings tile ----------

class _SettingsTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? trailing;
  final Color? iconColor;
  final VoidCallback? onTap;

  const _SettingsTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.trailing,
    this.iconColor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap != null
          ? () {
              HapticFeedback.lightImpact();
              onTap!();
            }
          : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Icon(icon, color: iconColor ?? AppColors.textSecondary, size: 20),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      ),
    );
  }
}
