import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:tamerclaw_mobile/core/api/api_client.dart';
import 'package:tamerclaw_mobile/core/api/api_endpoints.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';

/// Provider for live voice call state per agent.
final callProvider =
    StateNotifierProvider.family<CallNotifier, CallState, String>((ref, agentId) {
  final api = ref.watch(apiClientProvider);
  return CallNotifier(api, agentId);
});

enum CallPhase { idle, connecting, listening, processing, speaking, error, ended }

class CallState {
  final CallPhase phase;
  final Duration duration;
  final bool isMuted;
  final bool isSpeakerOn;
  final String? errorMessage;
  final String? statusText;

  const CallState({
    this.phase = CallPhase.idle,
    this.duration = Duration.zero,
    this.isMuted = false,
    this.isSpeakerOn = true,
    this.errorMessage,
    this.statusText,
  });

  bool get isActive =>
      phase != CallPhase.idle && phase != CallPhase.ended && phase != CallPhase.error;

  CallState copyWith({
    CallPhase? phase,
    Duration? duration,
    bool? isMuted,
    bool? isSpeakerOn,
    String? errorMessage,
    String? statusText,
  }) {
    return CallState(
      phase: phase ?? this.phase,
      duration: duration ?? this.duration,
      isMuted: isMuted ?? this.isMuted,
      isSpeakerOn: isSpeakerOn ?? this.isSpeakerOn,
      errorMessage: errorMessage,
      statusText: statusText,
    );
  }
}

class CallNotifier extends StateNotifier<CallState> {
  final ApiClient? _api;
  final String agentId;

  AudioRecorder? _recorder;
  AudioPlayer? _player;
  Timer? _durationTimer;
  Timer? _silenceTimer;
  Timer? _amplitudeTimer;
  String? _chatId;
  String? _currentRecordingPath;
  DateTime? _lastPollTimestamp;
  bool _disposed = false;

  // Silence detection configuration
  static const double _silenceThreshold = -35.0; // dB
  static const Duration _silenceTimeout = Duration(milliseconds: 1500);
  DateTime? _lastSoundTime;

  CallNotifier(this._api, this.agentId) : super(const CallState());

  /// Start a new voice call session.
  Future<void> startCall() async {
    if (_api == null) {
      state = const CallState(
        phase: CallPhase.error,
        errorMessage: 'Not connected to server',
      );
      return;
    }

    _disposed = false;
    _recorder = AudioRecorder();
    _player = AudioPlayer();
    _chatId = 'call_${DateTime.now().millisecondsSinceEpoch}';
    _lastPollTimestamp = DateTime.now();

    // Listen for playback completion to resume listening
    _player!.onPlayerComplete.listen((_) {
      if (!_disposed && state.isActive) {
        _onPlaybackComplete();
      }
    });

    state = const CallState(phase: CallPhase.connecting, statusText: 'Connecting...');

    // Start call duration timer
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && state.isActive) {
        state = state.copyWith(duration: state.duration + const Duration(seconds: 1));
      }
    });

    // Brief delay for UX then start listening
    await Future.delayed(const Duration(milliseconds: 500));

    if (!_disposed && mounted) {
      await _startListening();
    }
  }

  /// Start recording and monitoring amplitude for silence detection.
  Future<void> _startListening() async {
    if (_disposed || !mounted) return;

    if (state.isMuted) {
      state = state.copyWith(
        phase: CallPhase.listening,
        statusText: 'Muted',
      );
      return;
    }

    try {
      final hasPermission = await _recorder!.hasPermission();
      if (!hasPermission) {
        state = state.copyWith(
          phase: CallPhase.error,
          errorMessage: 'Microphone permission denied',
        );
        return;
      }

      final tempDir = await getTemporaryDirectory();
      _currentRecordingPath =
          '${tempDir.path}/call_${DateTime.now().millisecondsSinceEpoch}.m4a';

      await _recorder!.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          numChannels: 1,
          sampleRate: 16000,
        ),
        path: _currentRecordingPath!,
      );

      _lastSoundTime = DateTime.now();

      state = state.copyWith(
        phase: CallPhase.listening,
        statusText: 'Listening...',
      );

      // Start amplitude monitoring for silence detection
      _amplitudeTimer?.cancel();
      _amplitudeTimer = Timer.periodic(const Duration(milliseconds: 200), (_) async {
        if (_disposed || !mounted) {
          _amplitudeTimer?.cancel();
          return;
        }
        await _checkAmplitude();
      });
    } catch (e) {
      debugPrint('Call recording error: $e');
      if (mounted && !_disposed) {
        state = state.copyWith(
          phase: CallPhase.error,
          errorMessage: 'Failed to start microphone',
        );
      }
    }
  }

  /// Check amplitude and detect silence.
  Future<void> _checkAmplitude() async {
    if (_disposed || !mounted || state.phase != CallPhase.listening) return;

    try {
      final amplitude = await _recorder!.getAmplitude();
      final currentDb = amplitude.current;

      if (currentDb > _silenceThreshold) {
        // Sound detected
        _lastSoundTime = DateTime.now();
        _silenceTimer?.cancel();
        _silenceTimer = null;
      } else if (_lastSoundTime != null && _silenceTimer == null) {
        // Start silence timer
        final elapsed = DateTime.now().difference(_lastSoundTime!);
        if (elapsed >= _silenceTimeout) {
          // Silence detected after user spoke
          _onSilenceDetected();
        } else {
          _silenceTimer = Timer(_silenceTimeout - elapsed, () {
            if (!_disposed && mounted && state.phase == CallPhase.listening) {
              _onSilenceDetected();
            }
          });
        }
      }
    } catch (_) {
      // Ignore amplitude errors
    }
  }

  /// Called when silence is detected after the user was speaking.
  Future<void> _onSilenceDetected() async {
    _amplitudeTimer?.cancel();
    _silenceTimer?.cancel();

    if (_disposed || !mounted || state.phase != CallPhase.listening) return;

    state = state.copyWith(
      phase: CallPhase.processing,
      statusText: 'Processing...',
    );

    // Stop recording
    String? recordedPath;
    try {
      recordedPath = await _recorder!.stop();
    } catch (e) {
      debugPrint('Stop recording error: $e');
    }

    if (recordedPath == null || _disposed || !mounted) return;

    // Check if the file has meaningful content (not just silence)
    final file = File(recordedPath);
    if (!await file.exists() || (await file.stat()).size < 1000) {
      // Too short / empty recording, resume listening
      _cleanupFile(recordedPath);
      if (mounted && !_disposed && state.isActive) {
        await _startListening();
      }
      return;
    }

    // Send voice to backend
    await _sendVoiceAndWaitForResponse(recordedPath);
  }

  /// Send the recorded voice file to the backend and poll for a response.
  Future<void> _sendVoiceAndWaitForResponse(String filePath) async {
    if (_api == null || _disposed || !mounted) return;

    try {
      final multipartFile = await http.MultipartFile.fromPath(
        'files',
        filePath,
        filename: 'voice_call.m4a',
      );

      await _api!.postMultipart(
        ApiEndpoints.agentMessage(agentId),
        {
          'message': '[Voice call message]',
          'chatId': _chatId!,
          'fireAndForget': 'true',
          'isVoiceInput': 'true',
        },
        [multipartFile],
      );

      // Clean up the recorded file
      _cleanupFile(filePath);

      // Poll for response
      if (!_disposed && mounted && state.isActive) {
        await _pollForVoiceResponse();
      }
    } catch (e) {
      debugPrint('Send voice error: $e');
      _cleanupFile(filePath);

      if (mounted && !_disposed && state.isActive) {
        // On error, try to continue the call
        state = state.copyWith(
          phase: CallPhase.listening,
          statusText: 'Network error, retrying...',
        );
        await Future.delayed(const Duration(seconds: 1));
        if (mounted && !_disposed && state.isActive) {
          await _startListening();
        }
      }
    }
  }

  /// Poll for the agent's response message.
  Future<void> _pollForVoiceResponse() async {
    if (_api == null || _disposed || !mounted) return;

    const maxPollAttempts = 120; // 2 minutes max wait
    const pollInterval = Duration(seconds: 1);

    for (int attempt = 0; attempt < maxPollAttempts; attempt++) {
      if (_disposed || !mounted || !state.isActive) return;

      try {
        final since = _lastPollTimestamp?.toUtc().toIso8601String();
        final response = await _api!.get(
          ApiEndpoints.pollMessages(agentId, chatId: _chatId, since: since),
        );

        if (response is! Map) {
          await Future.delayed(pollInterval);
          continue;
        }

        final hasNew = response['hasNew'] == true;
        if (!hasNew) {
          // Check agent activity to update status text
          await _updateActivityStatus();
          await Future.delayed(pollInterval);
          continue;
        }

        final List<dynamic> messages = response['messages'] as List<dynamic>? ?? [];

        // Look for an agent response (non-user message)
        for (final msg in messages) {
          if (msg is! Map<String, dynamic>) continue;
          final role = msg['role']?.toString() ?? '';
          if (role == 'user') continue;

          final timestamp = DateTime.tryParse(msg['timestamp']?.toString() ?? '') ??
              DateTime.now();
          _lastPollTimestamp = timestamp;

          // Check for voice/audio attachment in the response
          String? audioUrl;
          if (msg['media'] is List) {
            for (final item in msg['media'] as List) {
              if (item is Map<String, dynamic>) {
                final mimeType = item['mimeType']?.toString() ?? '';
                if (mimeType.startsWith('audio/')) {
                  audioUrl = item['url']?.toString();
                  break;
                }
              }
            }
          }

          if (audioUrl != null && audioUrl.isNotEmpty) {
            // Play the voice response
            await _playVoiceResponse(audioUrl);
          } else {
            // No voice attachment — request TTS for the text response
            final textContent = msg['content']?.toString() ?? '';
            if (textContent.isNotEmpty && textContent.length > 3) {
              await _requestTtsAndPlay(textContent);
            } else if (mounted && !_disposed && state.isActive) {
              await _startListening();
            }
          }
          return;
        }

        await Future.delayed(pollInterval);
      } catch (e) {
        debugPrint('Poll error: $e');
        await Future.delayed(pollInterval);
      }
    }

    // Timeout -- resume listening
    if (mounted && !_disposed && state.isActive) {
      state = state.copyWith(
        phase: CallPhase.listening,
        statusText: 'Response timeout, listening...',
      );
      await _startListening();
    }
  }

  /// Update the status text based on agent activity.
  Future<void> _updateActivityStatus() async {
    if (_api == null || _disposed || !mounted) return;
    try {
      final response = await _api!.get(ApiEndpoints.agentActivity(agentId));
      if (response is! Map || _disposed || !mounted) return;

      final serverStatus = response['status']?.toString() ?? 'idle';
      final statusText = switch (serverStatus) {
        'thinking' => 'Thinking...',
        'working' => 'Working...',
        'responding' => 'Responding...',
        _ => 'Processing...',
      };

      if (mounted && !_disposed && state.phase == CallPhase.processing) {
        state = state.copyWith(statusText: statusText);
      }
    } catch (_) {}
  }

  /// Request TTS from the server and play the resulting audio.
  /// Used as fallback when the agent's response doesn't include a voice attachment.
  Future<void> _requestTtsAndPlay(String text) async {
    if (_api == null || _disposed || !mounted || !state.isActive) return;

    state = state.copyWith(
      phase: CallPhase.speaking,
      statusText: 'Generating voice...',
    );

    try {
      // Request TTS audio from backend
      final ttsUrl = ApiEndpoints.agentTts(agentId);
      final response = await _api!.postRaw(
        ttsUrl,
        {'text': text, 'voice': 'josh', 'model': 'flash'},
      );

      if (response == null || response.isEmpty || _disposed || !mounted) {
        // TTS failed — resume listening
        if (mounted && !_disposed && state.isActive) {
          await _startListening();
        }
        return;
      }

      // Save audio to temp file and play
      final tempDir = await getTemporaryDirectory();
      final audioPath = '${tempDir.path}/tts_${DateTime.now().millisecondsSinceEpoch}.ogg';
      final file = File(audioPath);
      await file.writeAsBytes(response);

      if (!_disposed && mounted && state.isActive) {
        state = state.copyWith(
          phase: CallPhase.speaking,
          statusText: 'Agent speaking...',
        );
        await _player!.play(DeviceFileSource(audioPath));
        // Playback completion handled by onPlayerComplete listener
      }
    } catch (e) {
      debugPrint('TTS request error: $e');
      // Fallback: resume listening
      if (mounted && !_disposed && state.isActive) {
        await _startListening();
      }
    }
  }

  /// Play the agent's voice response.
  Future<void> _playVoiceResponse(String audioUrl) async {
    if (_disposed || !mounted || !state.isActive) return;

    state = state.copyWith(
      phase: CallPhase.speaking,
      statusText: 'Agent speaking...',
    );

    try {
      // Build the full URL if it's a relative path
      String fullUrl = audioUrl;
      if (!audioUrl.startsWith('http')) {
        final baseUrl = _api!.baseUrl;
        final cleanBase =
            baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
        fullUrl = '$cleanBase$audioUrl';
      }

      await _player!.play(UrlSource(fullUrl));
      // Playback completion is handled by the onPlayerComplete listener
    } catch (e) {
      debugPrint('Playback error: $e');
      // If playback fails, resume listening
      if (mounted && !_disposed && state.isActive) {
        _onPlaybackComplete();
      }
    }
  }

  /// Called when voice playback finishes.
  void _onPlaybackComplete() {
    if (_disposed || !mounted || !state.isActive) return;
    _startListening();
  }

  /// Toggle mute state.
  void toggleMute() {
    final newMuted = !state.isMuted;
    state = state.copyWith(
      isMuted: newMuted,
      statusText: newMuted ? 'Muted' : null,
    );

    if (newMuted && state.phase == CallPhase.listening) {
      // Stop recording when muted
      _amplitudeTimer?.cancel();
      _silenceTimer?.cancel();
      _recorder?.stop().catchError((_) => null);
    } else if (!newMuted && state.phase == CallPhase.listening) {
      // Resume recording when unmuted
      _startListening();
    }
  }

  /// Toggle speaker mode.
  void toggleSpeaker() {
    state = state.copyWith(isSpeakerOn: !state.isSpeakerOn);
  }

  /// Hang up the call.
  Future<void> hangUp() async {
    _disposed = true;

    _durationTimer?.cancel();
    _amplitudeTimer?.cancel();
    _silenceTimer?.cancel();

    try {
      await _recorder?.stop();
    } catch (_) {}
    try {
      await _player?.stop();
    } catch (_) {}

    if (mounted) {
      state = state.copyWith(
        phase: CallPhase.ended,
        statusText: 'Call ended',
      );
    }

    // Brief delay then reset to idle
    await Future.delayed(const Duration(milliseconds: 800));
    if (mounted) {
      state = const CallState(phase: CallPhase.idle);
    }

    _cleanup();
  }

  void _cleanupFile(String path) {
    try {
      File(path).delete();
    } catch (_) {}
  }

  void _cleanup() {
    _recorder?.dispose();
    _player?.dispose();
    _recorder = null;
    _player = null;
    _durationTimer?.cancel();
    _amplitudeTimer?.cancel();
    _silenceTimer?.cancel();
  }

  @override
  void dispose() {
    _disposed = true;
    _cleanup();
    super.dispose();
  }
}
