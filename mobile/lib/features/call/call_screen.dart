import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/call/call_provider.dart';

class CallScreen extends ConsumerStatefulWidget {
  final String agentId;

  const CallScreen({super.key, required this.agentId});

  @override
  ConsumerState<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends ConsumerState<CallScreen>
    with TickerProviderStateMixin {
  late AnimationController _pulseController;
  late AnimationController _rippleController;
  late AnimationController _speakingController;
  late Animation<double> _pulseAnimation;
  late Animation<double> _rippleAnimation;
  late Animation<double> _speakingAnimation;

  @override
  void initState() {
    super.initState();

    // Pulsing animation for listening state
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _pulseAnimation = Tween<double>(begin: 1.0, end: 1.15).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    // Ripple animation for processing state
    _rippleController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    );
    _rippleAnimation = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _rippleController, curve: Curves.easeOut),
    );

    // Wave animation for speaking state
    _speakingController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );
    _speakingAnimation = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _speakingController, curve: Curves.easeInOut),
    );

    // Start the call
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(callProvider(widget.agentId).notifier).startCall();
    });
  }

  @override
  void dispose() {
    _pulseController.dispose();
    _rippleController.dispose();
    _speakingController.dispose();
    super.dispose();
  }

  void _updateAnimations(CallPhase phase) {
    switch (phase) {
      case CallPhase.listening:
        _pulseController.repeat(reverse: true);
        _rippleController.stop();
        _speakingController.stop();
        break;
      case CallPhase.processing:
        _pulseController.stop();
        _rippleController.repeat();
        _speakingController.stop();
        break;
      case CallPhase.speaking:
        _pulseController.stop();
        _rippleController.stop();
        _speakingController.repeat(reverse: true);
        break;
      default:
        _pulseController.stop();
        _rippleController.stop();
        _speakingController.stop();
    }
  }

  String _formatDuration(Duration d) {
    final minutes = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    if (d.inHours > 0) {
      final hours = d.inHours.toString().padLeft(2, '0');
      return '$hours:$minutes:$seconds';
    }
    return '$minutes:$seconds';
  }

  Future<void> _hangUp() async {
    HapticFeedback.heavyImpact();
    await ref.read(callProvider(widget.agentId).notifier).hangUp();
    if (mounted) {
      context.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final callState = ref.watch(callProvider(widget.agentId));
    final agent = ref.watch(agentByIdProvider(widget.agentId));

    // Drive animations based on phase
    _updateAnimations(callState.phase);

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              Color(0xFF0A0A1E),
              Color(0xFF0D0D2B),
              Color(0xFF151530),
            ],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              // Top bar with back button
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: Row(
                  children: [
                    IconButton(
                      icon: const Icon(
                        Icons.arrow_back_ios_rounded,
                        color: AppColors.textSecondary,
                        size: 20,
                      ),
                      onPressed: _hangUp,
                    ),
                    const Spacer(),
                    // Encrypted call indicator
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: AppColors.surfaceLight.withOpacity(0.4),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.lock_outline, color: AppColors.textSecondary, size: 12),
                          SizedBox(width: 4),
                          Text(
                            'Voice Call',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 11,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Spacer(),
                    const SizedBox(width: 48), // Balance the back button
                  ],
                ),
              ),

              const Spacer(flex: 2),

              // Agent avatar with animated rings
              _AnimatedAvatar(
                phase: callState.phase,
                agentName: agent?.displayName ?? widget.agentId,
                pulseAnimation: _pulseAnimation,
                rippleAnimation: _rippleAnimation,
                speakingAnimation: _speakingAnimation,
              ),

              const SizedBox(height: 24),

              // Agent name
              Text(
                agent?.displayName ?? widget.agentId,
                style: const TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 24,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.3,
                ),
              ),

              const SizedBox(height: 8),

              // Status text
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                child: Text(
                  callState.statusText ?? _defaultStatusText(callState.phase),
                  key: ValueKey(callState.statusText ?? callState.phase),
                  style: TextStyle(
                    color: _statusColor(callState.phase),
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),

              const SizedBox(height: 12),

              // Call duration
              if (callState.isActive || callState.phase == CallPhase.ended)
                Text(
                  _formatDuration(callState.duration),
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 16,
                    fontWeight: FontWeight.w400,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),

              const Spacer(flex: 3),

              // Control buttons
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 40),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    // Speaker toggle
                    _CallControlButton(
                      icon: callState.isSpeakerOn
                          ? Icons.volume_up_rounded
                          : Icons.volume_off_rounded,
                      label: 'Speaker',
                      isActive: callState.isSpeakerOn,
                      onPressed: () {
                        HapticFeedback.selectionClick();
                        ref.read(callProvider(widget.agentId).notifier).toggleSpeaker();
                      },
                    ),

                    // Mute toggle
                    _CallControlButton(
                      icon: callState.isMuted
                          ? Icons.mic_off_rounded
                          : Icons.mic_rounded,
                      label: callState.isMuted ? 'Unmute' : 'Mute',
                      isActive: !callState.isMuted,
                      isWarning: callState.isMuted,
                      onPressed: () {
                        HapticFeedback.selectionClick();
                        ref.read(callProvider(widget.agentId).notifier).toggleMute();
                      },
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 40),

              // Hang up button
              GestureDetector(
                onTap: _hangUp,
                child: Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    color: AppColors.error,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.error.withOpacity(0.35),
                        blurRadius: 20,
                        spreadRadius: 2,
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.call_end_rounded,
                    color: Colors.white,
                    size: 32,
                  ),
                ),
              ),

              const SizedBox(height: 48),
            ],
          ),
        ),
      ),
    );
  }

  String _defaultStatusText(CallPhase phase) {
    return switch (phase) {
      CallPhase.idle => '',
      CallPhase.connecting => 'Connecting...',
      CallPhase.listening => 'Listening...',
      CallPhase.processing => 'Processing...',
      CallPhase.speaking => 'Agent speaking...',
      CallPhase.error => 'Error',
      CallPhase.ended => 'Call ended',
    };
  }

  Color _statusColor(CallPhase phase) {
    return switch (phase) {
      CallPhase.listening => AppColors.online,
      CallPhase.processing => AppColors.warning,
      CallPhase.speaking => AppColors.accent,
      CallPhase.error => AppColors.error,
      _ => AppColors.textSecondary,
    };
  }
}

// ---- Animated avatar with phase-dependent visual effects ----

class _AnimatedAvatar extends StatelessWidget {
  final CallPhase phase;
  final String agentName;
  final Animation<double> pulseAnimation;
  final Animation<double> rippleAnimation;
  final Animation<double> speakingAnimation;

  const _AnimatedAvatar({
    required this.phase,
    required this.agentName,
    required this.pulseAnimation,
    required this.rippleAnimation,
    required this.speakingAnimation,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 180,
      height: 180,
      child: Stack(
        alignment: Alignment.center,
        children: [
          // Ripple rings for processing state
          if (phase == CallPhase.processing)
            AnimatedBuilder(
              animation: rippleAnimation,
              builder: (context, child) {
                return CustomPaint(
                  size: const Size(180, 180),
                  painter: _RipplePainter(
                    progress: rippleAnimation.value,
                    color: AppColors.warning,
                  ),
                );
              },
            ),

          // Speaking wave rings
          if (phase == CallPhase.speaking)
            AnimatedBuilder(
              animation: speakingAnimation,
              builder: (context, child) {
                return CustomPaint(
                  size: const Size(180, 180),
                  painter: _SpeakingWavePainter(
                    progress: speakingAnimation.value,
                    color: AppColors.accent,
                  ),
                );
              },
            ),

          // Pulsing ring for listening state
          if (phase == CallPhase.listening)
            AnimatedBuilder(
              animation: pulseAnimation,
              builder: (context, child) {
                return Transform.scale(
                  scale: pulseAnimation.value,
                  child: Container(
                    width: 140,
                    height: 140,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppColors.online.withOpacity(0.3),
                        width: 2,
                      ),
                    ),
                  ),
                );
              },
            ),

          // Core avatar circle
          Container(
            width: 120,
            height: 120,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  _avatarColor(phase).withOpacity(0.3),
                  _avatarColor(phase).withOpacity(0.1),
                ],
              ),
              border: Border.all(
                color: _avatarColor(phase).withOpacity(0.5),
                width: 2,
              ),
              boxShadow: [
                BoxShadow(
                  color: _avatarColor(phase).withOpacity(0.2),
                  blurRadius: 24,
                  spreadRadius: 4,
                ),
              ],
            ),
            child: Center(
              child: Icon(
                Icons.smart_toy_rounded,
                size: 48,
                color: _avatarColor(phase),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Color _avatarColor(CallPhase phase) {
    return switch (phase) {
      CallPhase.listening => AppColors.online,
      CallPhase.processing => AppColors.warning,
      CallPhase.speaking => AppColors.accent,
      CallPhase.error => AppColors.error,
      _ => AppColors.textSecondary,
    };
  }
}

// ---- Ripple painter for processing state ----

class _RipplePainter extends CustomPainter {
  final double progress;
  final Color color;

  _RipplePainter({required this.progress, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final maxRadius = size.width / 2;

    for (int i = 0; i < 3; i++) {
      final rippleProgress = (progress + i * 0.33) % 1.0;
      final radius = maxRadius * 0.5 + maxRadius * 0.5 * rippleProgress;
      final opacity = (1.0 - rippleProgress) * 0.4;

      final paint = Paint()
        ..color = color.withOpacity(opacity)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.0;

      canvas.drawCircle(center, radius, paint);
    }
  }

  @override
  bool shouldRepaint(_RipplePainter oldDelegate) =>
      oldDelegate.progress != progress;
}

// ---- Speaking wave painter ----

class _SpeakingWavePainter extends CustomPainter {
  final double progress;
  final Color color;

  _SpeakingWavePainter({required this.progress, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final maxRadius = size.width / 2;

    for (int i = 0; i < 4; i++) {
      final waveOffset = sin(progress * pi * 2 + i * pi / 2) * 0.1;
      final baseRadius = 0.5 + i * 0.12;
      final radius = maxRadius * (baseRadius + waveOffset);
      final opacity = (1.0 - (i * 0.2)) * 0.35;

      final paint = Paint()
        ..color = color.withOpacity(opacity.clamp(0.05, 0.4))
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5;

      canvas.drawCircle(center, radius, paint);
    }
  }

  @override
  bool shouldRepaint(_SpeakingWavePainter oldDelegate) =>
      oldDelegate.progress != progress;
}

// ---- Call control button ----

class _CallControlButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool isActive;
  final bool isWarning;
  final VoidCallback onPressed;

  const _CallControlButton({
    required this.icon,
    required this.label,
    this.isActive = true,
    this.isWarning = false,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final bgColor = isWarning
        ? AppColors.error.withOpacity(0.2)
        : isActive
            ? AppColors.surfaceLight.withOpacity(0.6)
            : AppColors.surfaceLight.withOpacity(0.3);

    final iconColor = isWarning
        ? AppColors.error
        : isActive
            ? AppColors.textPrimary
            : AppColors.textSecondary;

    return GestureDetector(
      onTap: onPressed,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              color: bgColor,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: iconColor, size: 26),
          ),
          const SizedBox(height: 8),
          Text(
            label,
            style: TextStyle(
              color: iconColor,
              fontSize: 11,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}
