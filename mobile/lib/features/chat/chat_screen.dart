import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gal/gal.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';
import 'package:tamerclaw_mobile/core/notifications/push_notification_service.dart';
import 'package:tamerclaw_mobile/core/theme/app_theme.dart';
import 'package:tamerclaw_mobile/features/agents/agents_provider.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';
import 'package:tamerclaw_mobile/features/chat/chat_provider.dart'
    show chatProvider, AgentActivityStatus;
import 'package:tamerclaw_mobile/shared/models/agent.dart';
import 'package:tamerclaw_mobile/shared/models/message.dart';
import 'package:intl/intl.dart';

class ChatScreen extends ConsumerStatefulWidget {
  final String agentId;
  final String? chatId;

  const ChatScreen({super.key, required this.agentId, this.chatId});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> with WidgetsBindingObserver {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();
  final _focusNode = FocusNode();
  bool _showScrollToBottom = false;
  int _prevMessageCount = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scrollController.addListener(_onScroll);

    // Suppress notifications for the agent we're actively viewing
    PushNotificationService().setActiveAgentId(widget.agentId);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final notifier = ref.read(chatProvider(widget.agentId).notifier);

      // Pre-load sessions so session IDs in messages are tappable
      notifier.loadSessions();

      if (widget.chatId != null && widget.chatId!.isNotEmpty) {
        // Load existing session and start polling
        notifier.loadSession(widget.chatId!);
      } else {
        // New chat — start polling for 2-way communication
        notifier.startPolling();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final notifier = ref.read(chatProvider(widget.agentId).notifier);
    final pushService = PushNotificationService();
    if (state == AppLifecycleState.resumed) {
      pushService.setAppInForeground(true);
      pushService.setActiveAgentId(widget.agentId);
      // Resume polling when app comes back to foreground
      notifier.startPolling();
      // Note: notification-tap navigation is handled centrally by
      // _TamerClawAppState and PushNotificationService.setRouter().
    } else if (state == AppLifecycleState.paused) {
      pushService.setAppInForeground(false);
      // Keep polling in background for push notifications — but slower
      // (don't stop, just reduce frequency)
    }
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final atBottom = _scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 100;
    if (_showScrollToBottom == atBottom) {
      setState(() => _showScrollToBottom = !atBottom);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scrollController.removeListener(_onScroll);
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    // Clear active agent so notifications resume for this agent
    PushNotificationService().setActiveAgentId(null);
    // Stop polling when leaving chat screen
    ref.read(chatProvider(widget.agentId).notifier).stopPolling();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _sendMessage({List<ChatAttachment> attachments = const []}) {
    final text = _controller.text.trim();
    if (text.isEmpty && attachments.isEmpty) return;

    HapticFeedback.lightImpact();
    ref.read(chatProvider(widget.agentId).notifier).sendMessage(
          text,
          attachments: attachments,
        );
    _controller.clear();
    _focusNode.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final chatState = ref.watch(chatProvider(widget.agentId));
    final agent = ref.watch(agentByIdProvider(widget.agentId));
    final isConnected =
        ref.read(chatProvider(widget.agentId).notifier).isConnected;

    // Auto-scroll when new messages arrive
    if (chatState.messages.length != _prevMessageCount) {
      _prevMessageCount = chatState.messages.length;
      _scrollToBottom();
    }

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            // Status dot with polling indicator
            Stack(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  margin: const EdgeInsets.only(right: 10),
                  decoration: BoxDecoration(
                    color: agent?.isActive == true
                        ? AppColors.online
                        : AppColors.offline,
                    shape: BoxShape.circle,
                  ),
                ),
                if (chatState.isPolling)
                  Positioned(
                    right: 4,
                    bottom: -4,
                    child: Container(
                      width: 5,
                      height: 5,
                      decoration: BoxDecoration(
                        color: AppColors.accent,
                        shape: BoxShape.circle,
                        border: Border.all(color: AppColors.surface, width: 1),
                      ),
                    ),
                  ),
              ],
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    agent?.displayName ?? widget.agentId,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                  Row(
                    children: [
                      if (chatState.agentStatus != AgentActivityStatus.idle) ...[
                        Text(
                          chatState.agentStatusText,
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppColors.online,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const SizedBox(width: 4),
                        const _MiniPulse(),
                      ] else if (agent != null) ...[
                        Text(
                          agent.modelBadge,
                          style: TextStyle(
                            fontSize: 12,
                            color: agent.modelColor,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                      if (chatState.isPolling && chatState.agentStatus == AgentActivityStatus.idle) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(
                            color: AppColors.accent.withOpacity(0.15),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text(
                            'LIVE',
                            style: TextStyle(
                              color: AppColors.accent,
                              fontSize: 9,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.5,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          // Stop button — visible when agent is busy
          if (chatState.isAgentBusy)
            IconButton(
              icon: Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  color: AppColors.error.withOpacity(0.15),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.stop_rounded,
                    color: AppColors.error, size: 18),
              ),
              tooltip: 'Stop Agent',
              onPressed: () {
                HapticFeedback.heavyImpact();
                ref.read(chatProvider(widget.agentId).notifier).stopAgent();
              },
            ),
          IconButton(
            icon: const Icon(Icons.add_comment_outlined,
                color: AppColors.textSecondary, size: 22),
            tooltip: 'New Chat',
            onPressed: () {
              HapticFeedback.lightImpact();
              ref.read(chatProvider(widget.agentId).notifier).startNewChat();
              ref.read(chatProvider(widget.agentId).notifier).startPolling();
            },
          ),
          IconButton(
            icon: const Icon(Icons.history,
                color: AppColors.textSecondary, size: 22),
            tooltip: 'Sessions',
            onPressed: () {
              HapticFeedback.lightImpact();
              context.push('/agents/${widget.agentId}/sessions');
            },
          ),
        ],
      ),
      body: Column(
        children: [
          // Connection status banner
          if (!isConnected)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 6),
              color: AppColors.error,
              child: const Text(
                'Not connected to server',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),

          // Session loading indicator
          if (chatState.isLoadingHistory)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 8),
              color: AppColors.accent.withOpacity(0.1),
              child: const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: AppColors.accent,
                    ),
                  ),
                  SizedBox(width: 8),
                  Text(
                    'Resuming session...',
                    style: TextStyle(
                      color: AppColors.accent,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),

          // Messages
          Expanded(
            child: Stack(
              children: [
                chatState.messages.isEmpty && !chatState.isLoadingHistory
                    ? _EmptyChat(agent: agent, agentId: widget.agentId)
                    : ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 8),
                        itemCount: chatState.messages.length,
                        itemBuilder: (context, index) {
                          final msg = chatState.messages[index];
                          // Show date separator if date changes
                          final showDate = index == 0 ||
                              !_isSameDay(
                                chatState.messages[index - 1].timestamp,
                                msg.timestamp,
                              );
                          return Column(
                            children: [
                              if (showDate)
                                _DateSeparator(date: msg.timestamp),
                              _MessageBubble(
                                message: msg,
                                serverUrl: ref.read(authProvider).serverUrl,
                                token: ref.read(authProvider).token,
                                agentId: widget.agentId,
                                sessions: chatState.sessions,
                                onRetry: msg.isError
                                    ? () => ref
                                        .read(
                                            chatProvider(widget.agentId).notifier)
                                        .retry()
                                    : null,
                              ),
                            ],
                          );
                        },
                      ),
                // Scroll to bottom FAB
                if (_showScrollToBottom)
                  Positioned(
                    bottom: 8,
                    right: 8,
                    child: FloatingActionButton.small(
                      backgroundColor: AppColors.surface,
                      foregroundColor: AppColors.textPrimary,
                      onPressed: _scrollToBottom,
                      child: const Icon(Icons.keyboard_arrow_down),
                    ),
                  ),
              ],
            ),
          ),

          // Quick action bar
          _QuickActionBar(
            agentId: widget.agentId,
            onAction: (command) {
              HapticFeedback.lightImpact();
              ref.read(chatProvider(widget.agentId).notifier).sendMessage(command);
              _scrollToBottom();
            },
          ),

          // Floating agent activity status banner
          _AgentActivityBanner(
            status: chatState.agentStatus,
            onStop: () {
              ref.read(chatProvider(widget.agentId).notifier).stopAgent();
            },
          ),

          // Input area — always enabled (message queuing handles concurrency)
          _ChatInput(
            controller: _controller,
            focusNode: _focusNode,
            isSending: false, // Never block input — messages queue automatically
            onSend: _sendMessage,
            onStop: () {
              HapticFeedback.heavyImpact();
              ref.read(chatProvider(widget.agentId).notifier).stopAgent();
            },
            agentId: widget.agentId,
            pendingCount: chatState.pendingMessages,
            isAgentBusy: chatState.isAgentBusy,
          ),
        ],
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }
}

// ---------- Date separator ----------

class _DateSeparator extends StatelessWidget {
  final DateTime date;

  const _DateSeparator({required this.date});

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    String label;
    if (_isSameDay(date, now)) {
      label = 'Today';
    } else if (_isSameDay(date, now.subtract(const Duration(days: 1)))) {
      label = 'Yesterday';
    } else {
      label = DateFormat('MMM d, yyyy').format(date);
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Container(height: 0.5, color: AppColors.surfaceLight),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(
              label,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 11,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          Expanded(
            child: Container(height: 0.5, color: AppColors.surfaceLight),
          ),
        ],
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }
}

// ---------- Empty state ----------

class _EmptyChat extends StatelessWidget {
  final Agent? agent;
  final String agentId;

  const _EmptyChat({required this.agent, required this.agentId});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircleAvatar(
              radius: 32,
              backgroundColor:
                  (agent?.modelColor ?? AppColors.accent).withOpacity(0.15),
              child: Text(
                (agent?.displayName ?? agentId).isNotEmpty
                    ? (agent?.displayName ?? agentId)[0].toUpperCase()
                    : '?',
                style: TextStyle(
                  color: agent?.modelColor ?? AppColors.accent,
                  fontSize: 28,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Chat with ${agent?.displayName ?? agentId}',
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontSize: 16,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Send a message to start the conversation.\nAgent messages from Telegram will appear here too.',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: AppColors.textSecondary,
                fontSize: 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Agent activity banner ----------

class _AgentActivityBanner extends StatefulWidget {
  final AgentActivityStatus status;
  final VoidCallback? onStop;

  const _AgentActivityBanner({required this.status, this.onStop});

  @override
  State<_AgentActivityBanner> createState() => _AgentActivityBannerState();
}

class _AgentActivityBannerState extends State<_AgentActivityBanner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  String _statusText(AgentActivityStatus status) {
    return switch (status) {
      AgentActivityStatus.idle => '',
      AgentActivityStatus.receiving => 'Agent is receiving...',
      AgentActivityStatus.thinking => 'Agent is thinking...',
      AgentActivityStatus.working => 'Agent is working...',
      AgentActivityStatus.broadcasting => 'Agent is responding...',
    };
  }

  @override
  Widget build(BuildContext context) {
    final isActive = widget.status != AgentActivityStatus.idle;

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      transitionBuilder: (child, animation) {
        return SizeTransition(
          sizeFactor: animation,
          axisAlignment: 1.0,
          child: FadeTransition(opacity: animation, child: child),
        );
      },
      child: isActive
          ? Container(
              key: const ValueKey('activity_banner'),
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: BoxDecoration(
                color: AppColors.surface.withOpacity(0.95),
                border: const Border(
                  top: BorderSide(color: AppColors.surfaceLight, width: 0.5),
                  bottom: BorderSide(color: AppColors.surfaceLight, width: 0.5),
                ),
              ),
              child: Row(
                children: [
                  const Spacer(),
                  // Pulsing dot
                  AnimatedBuilder(
                    animation: _pulseController,
                    builder: (context, _) {
                      return Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: AppColors.accent.withOpacity(
                            0.4 + 0.6 * _pulseController.value,
                          ),
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.accent.withOpacity(
                                0.3 * _pulseController.value,
                              ),
                              blurRadius: 6,
                              spreadRadius: 1,
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                  const SizedBox(width: 10),
                  Text(
                    _statusText(widget.status),
                    style: const TextStyle(
                      color: AppColors.accent,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.2,
                    ),
                  ),
                  const Spacer(),
                  // Stop button on the right side of the banner
                  if (widget.onStop != null)
                    GestureDetector(
                      onTap: () {
                        HapticFeedback.heavyImpact();
                        widget.onStop!();
                      },
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: AppColors.error.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.stop_rounded,
                                color: AppColors.error, size: 16),
                            SizedBox(width: 4),
                            Text(
                              'Stop',
                              style: TextStyle(
                                color: AppColors.error,
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            )
          : const SizedBox.shrink(key: ValueKey('activity_empty')),
    );
  }
}

// ---------- Chat input with attachments & voice ----------

class _ChatInput extends StatefulWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool isSending;
  final void Function({List<ChatAttachment> attachments}) onSend;
  final VoidCallback? onStop;
  final String agentId;
  final int pendingCount;
  final bool isAgentBusy;

  const _ChatInput({
    required this.controller,
    required this.focusNode,
    required this.isSending,
    required this.onSend,
    this.onStop,
    required this.agentId,
    this.pendingCount = 0,
    this.isAgentBusy = false,
  });

  @override
  State<_ChatInput> createState() => _ChatInputState();
}

class _ChatInputState extends State<_ChatInput>
    with SingleTickerProviderStateMixin {
  final List<ChatAttachment> _attachments = [];
  final _imagePicker = ImagePicker();
  late final AudioRecorder _audioRecorder;

  bool _isRecording = false;
  bool _recordingCancelled = false;
  Duration _recordingDuration = Duration.zero;
  Timer? _recordingTimer;
  double _dragStartX = 0;
  double _dragOffsetX = 0;
  bool _hasText = false;
  bool _isLongPressing = false;

  // Animation controller for send/mic button scale transition
  late final AnimationController _buttonScaleController;
  late final Animation<double> _buttonScaleAnimation;

  @override
  void initState() {
    super.initState();
    _audioRecorder = AudioRecorder();
    widget.controller.addListener(_onTextChanged);
    _buttonScaleController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
      value: 1.0,
      lowerBound: 0.0,
      upperBound: 1.0,
    );
    _buttonScaleAnimation = CurvedAnimation(
      parent: _buttonScaleController,
      curve: Curves.easeOutBack,
    );
  }

  void _onTextChanged() {
    final hasText = widget.controller.text.trim().isNotEmpty;
    if (hasText != _hasText) {
      // Trigger scale bounce when switching between mic and send
      _buttonScaleController.forward(from: 0.0);
      setState(() => _hasText = hasText);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    _recordingTimer?.cancel();
    _audioRecorder.dispose();
    _buttonScaleController.dispose();
    super.dispose();
  }

  void _removeAttachment(int index) {
    setState(() => _attachments.removeAt(index));
  }

  Future<void> _showAttachmentOptions() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.surfaceLight,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(height: 16),
              _AttachmentOption(
                icon: Icons.camera_alt_outlined,
                label: 'Camera',
                onTap: () {
                  Navigator.pop(ctx);
                  _pickFromCamera();
                },
              ),
              _AttachmentOption(
                icon: Icons.photo_library_outlined,
                label: 'Gallery',
                onTap: () {
                  Navigator.pop(ctx);
                  _pickFromGallery();
                },
              ),
              _AttachmentOption(
                icon: Icons.insert_drive_file_outlined,
                label: 'File',
                onTap: () {
                  Navigator.pop(ctx);
                  _pickFile();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _pickFromCamera() async {
    try {
      final photo = await _imagePicker.pickImage(
        source: ImageSource.camera,
        imageQuality: 80,
      );
      if (photo != null) {
        await _addImageAttachment(photo);
      }
    } catch (_) {}
  }

  Future<void> _pickFromGallery() async {
    try {
      final images = await _imagePicker.pickMultiImage(imageQuality: 80);
      for (final image in images) {
        await _addImageAttachment(image);
      }
    } catch (_) {}
  }

  Future<void> _addImageAttachment(XFile file) async {
    final stat = await File(file.path).stat();
    final mimeType = lookupMimeType(file.path) ?? 'image/jpeg';
    setState(() {
      _attachments.add(ChatAttachment(
        name: file.name,
        path: file.path,
        mimeType: mimeType,
        size: stat.size,
        type: AttachmentType.image,
      ));
    });
  }

  Future<void> _pickFile() async {
    try {
      final result = await FilePicker.platform.pickFiles(allowMultiple: true);
      if (result == null) return;

      for (final file in result.files) {
        if (file.path == null) continue;
        final mimeType = lookupMimeType(file.path!) ?? 'application/octet-stream';
        setState(() {
          _attachments.add(ChatAttachment(
            name: file.name,
            path: file.path!,
            mimeType: mimeType,
            size: file.size,
            type: AttachmentType.file,
          ));
        });
      }
    } catch (_) {}
  }

  // ---------- Voice recording ----------

  Future<void> _startRecording() async {
    try {
      if (await _audioRecorder.hasPermission()) {
        final tempDir = await getTemporaryDirectory();
        final filePath =
            '${tempDir.path}/voice_${DateTime.now().millisecondsSinceEpoch}.m4a';

        await _audioRecorder.start(
          const RecordConfig(
            encoder: AudioEncoder.aacLc,
            numChannels: 1,
            sampleRate: 16000,
          ),
          path: filePath,
        );

        setState(() {
          _isRecording = true;
          _recordingCancelled = false;
          _recordingDuration = Duration.zero;
          _dragOffsetX = 0;
        });

        _recordingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
          if (mounted) {
            setState(() => _recordingDuration += const Duration(seconds: 1));
          }
        });

        HapticFeedback.mediumImpact();
      }
    } catch (e) {
      debugPrint('Recording error: $e');
    }
  }

  Future<void> _stopRecording({bool cancel = false}) async {
    _recordingTimer?.cancel();

    if (!_isRecording) return;

    final path = await _audioRecorder.stop();

    setState(() {
      _isRecording = false;
      _recordingDuration = Duration.zero;
    });

    if (cancel || _recordingCancelled || path == null) {
      // Clean up cancelled recording file.
      if (path != null) {
        try {
          await File(path).delete();
        } catch (_) {}
      }
      return;
    }

    // Send voice note as attachment.
    final file = File(path);
    if (await file.exists()) {
      final stat = await file.stat();

      // Reject files larger than 10 MB
      const maxSize = 10 * 1024 * 1024; // 10 MB
      if (stat.size > maxSize) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Voice note is too large (>10 MB). Please record a shorter message.',
              ),
              backgroundColor: AppColors.error,
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
        try {
          await file.delete();
        } catch (_) {}
        return;
      }

      // Determine mime type from extension
      final ext = p.extension(path).toLowerCase();
      final mimeType = switch (ext) {
        '.wav' => 'audio/wav',
        '.m4a' => 'audio/mp4',
        '.aac' => 'audio/aac',
        _ => 'audio/mp4',
      };
      final attachment = ChatAttachment(
        name: p.basename(path),
        path: path,
        mimeType: mimeType,
        size: stat.size,
        type: AttachmentType.voice,
      );
      widget.onSend(attachments: [attachment]);
    }
  }

  void _handleSendOrVoice() {
    if (_hasText || _attachments.isNotEmpty) {
      final atts = List<ChatAttachment>.from(_attachments);
      _attachments.clear();
      setState(() {});
      widget.onSend(attachments: atts);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(top: BorderSide(color: AppColors.surfaceLight)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Attachment previews
            if (_attachments.isNotEmpty)
              SizedBox(
                height: 80,
                child: ListView.builder(
                  scrollDirection: Axis.horizontal,
                  padding:
                      const EdgeInsets.only(left: 12, right: 12, top: 8),
                  itemCount: _attachments.length,
                  itemBuilder: (context, index) {
                    final att = _attachments[index];
                    return _AttachmentPreview(
                      attachment: att,
                      onRemove: () => _removeAttachment(index),
                    );
                  },
                ),
              ),

            // Recording indicator
            if (_isRecording)
              _RecordingIndicator(
                duration: _recordingDuration,
                dragOffset: _dragOffsetX,
              ),

            // Input row
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  // Attachment button
                  if (!_isRecording)
                    IconButton(
                      onPressed: _showAttachmentOptions,
                      icon: const Icon(Icons.attach_file,
                          color: AppColors.textSecondary, size: 22),
                      constraints:
                          const BoxConstraints(minWidth: 36, minHeight: 36),
                      padding: EdgeInsets.zero,
                    ),

                  // Text field (hidden during recording)
                  if (!_isRecording)
                    Expanded(
                      child: TextField(
                        controller: widget.controller,
                        focusNode: widget.focusNode,
                        style: const TextStyle(
                            color: AppColors.textPrimary, fontSize: 15),
                        maxLines: 4,
                        minLines: 1,
                        textCapitalization: TextCapitalization.sentences,
                        decoration: InputDecoration(
                          hintText: 'Message...',
                          filled: true,
                          fillColor: AppColors.surfaceLight,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(24),
                            borderSide: BorderSide.none,
                          ),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 10,
                          ),
                          isDense: true,
                        ),
                        onSubmitted: (_) => _handleSendOrVoice(),
                      ),
                    ),

                  // Spacer during recording
                  if (_isRecording) const Spacer(),

                  const SizedBox(width: 8),

                  // Send, stop, or mic button with scale animation
                  ScaleTransition(
                    scale: _buttonScaleAnimation,
                    child: (_hasText || _attachments.isNotEmpty)
                        ? Stack(
                            clipBehavior: Clip.none,
                            children: [
                              Container(
                                decoration: const BoxDecoration(
                                  color: AppColors.accent,
                                  shape: BoxShape.circle,
                                ),
                                child: IconButton(
                                  icon: const Icon(Icons.send,
                                      color: Colors.white, size: 20),
                                  onPressed: _handleSendOrVoice,
                                ),
                              ),
                              // Queue count badge
                              if (widget.pendingCount > 0)
                                Positioned(
                                  top: -4,
                                  right: -4,
                                  child: Container(
                                    padding: const EdgeInsets.all(4),
                                    decoration: const BoxDecoration(
                                      color: AppColors.error,
                                      shape: BoxShape.circle,
                                    ),
                                    child: Text(
                                      '${widget.pendingCount}',
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 10,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                          )
                        : widget.isAgentBusy && !_isRecording
                        // Stop button when agent is busy and text field is empty
                        ? GestureDetector(
                            onTap: widget.onStop,
                            child: Container(
                              width: 40,
                              height: 40,
                              decoration: BoxDecoration(
                                color: AppColors.error.withOpacity(0.15),
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(
                                Icons.stop_rounded,
                                color: AppColors.error,
                                size: 24,
                              ),
                            ),
                          )
                        :
                        // Mic button with tap-to-toggle AND hold-to-record
                        GestureDetector(
                            onTap: () {
                              if (_isLongPressing) return;
                              // Tap to toggle recording on/off
                              if (_isRecording) {
                                _stopRecording();
                              } else {
                                _startRecording();
                              }
                            },
                            onLongPressStart: (details) {
                              _isLongPressing = true;
                              _dragStartX = details.globalPosition.dx;
                              _startRecording();
                            },
                            onLongPressMoveUpdate: (details) {
                              final dx =
                                  details.globalPosition.dx - _dragStartX;
                              setState(() {
                                _dragOffsetX = dx;
                                if (dx < -100) {
                                  _recordingCancelled = true;
                                }
                              });
                            },
                            onLongPressEnd: (_) {
                              _stopRecording(cancel: _recordingCancelled);
                              _isLongPressing = false;
                            },
                            child: Container(
                              width: 40,
                              height: 40,
                              decoration: BoxDecoration(
                                color: _isRecording
                                    ? AppColors.error
                                    : AppColors.surfaceLight,
                                shape: BoxShape.circle,
                              ),
                              child: Icon(
                                _isRecording ? Icons.stop : Icons.mic,
                                color: _isRecording
                                    ? Colors.white
                                    : AppColors.textSecondary,
                                size: 22,
                              ),
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Attachment option in bottom sheet ----------

class _AttachmentOption extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _AttachmentOption({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Container(
        width: 42,
        height: 42,
        decoration: BoxDecoration(
          color: AppColors.accent.withOpacity(0.1),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, color: AppColors.accent, size: 22),
      ),
      title: Text(
        label,
        style: const TextStyle(
          color: AppColors.textPrimary,
          fontSize: 15,
          fontWeight: FontWeight.w500,
        ),
      ),
      onTap: onTap,
    );
  }
}

// ---------- Attachment preview chip ----------

class _AttachmentPreview extends StatelessWidget {
  final ChatAttachment attachment;
  final VoidCallback onRemove;

  const _AttachmentPreview({
    required this.attachment,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 68,
      margin: const EdgeInsets.only(right: 8),
      child: Stack(
        children: [
          if (attachment.isImage)
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.file(
                File(attachment.path),
                width: 68,
                height: 68,
                fit: BoxFit.cover,
              ),
            )
          else
            Container(
              width: 68,
              height: 68,
              decoration: BoxDecoration(
                color: AppColors.surfaceLight,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.insert_drive_file,
                      color: AppColors.accent, size: 24),
                  const SizedBox(height: 4),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Text(
                      attachment.name,
                      style: const TextStyle(
                        color: AppColors.textSecondary,
                        fontSize: 9,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                    ),
                  ),
                ],
              ),
            ),
          // Remove button
          Positioned(
            top: 0,
            right: 0,
            child: GestureDetector(
              onTap: onRemove,
              child: Container(
                width: 20,
                height: 20,
                decoration: const BoxDecoration(
                  color: AppColors.error,
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.close, color: Colors.white, size: 12),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Quick action bar ----------

class _QuickActionBar extends StatelessWidget {
  final void Function(String command) onAction;
  final String agentId;

  const _QuickActionBar({required this.onAction, required this.agentId});

  static const _actions = [
    _QuickAction(Icons.history, 'Sessions', '/sessions'),
    _QuickAction(Icons.info_outline, 'Status', '/status'),
    _QuickAction(Icons.refresh, 'Restart', '/restart'),
    _QuickAction(Icons.summarize_outlined, 'Summary', '/summary'),
    _QuickAction(Icons.memory, 'Memory', '/memory'),
    _QuickAction(Icons.help_outline, 'Help', '/help'),
  ];

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 44,
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.surfaceLight, width: 0.5)),
      ),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        itemCount: _actions.length,
        separatorBuilder: (_, __) => const SizedBox(width: 6),
        itemBuilder: (context, index) {
          final action = _actions[index];
          return GestureDetector(
            onTap: () {
              if (action.command == '/sessions') {
                HapticFeedback.lightImpact();
                context.push('/agents/$agentId/sessions');
              } else {
                onAction(action.command);
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.surfaceLight,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: AppColors.accent.withOpacity(0.2),
                  width: 0.5,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(action.icon, size: 15, color: AppColors.accent),
                  const SizedBox(width: 5),
                  Text(
                    action.label,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _QuickAction {
  final IconData icon;
  final String label;
  final String command;

  const _QuickAction(this.icon, this.label, this.command);
}

// ---------- Recording indicator ----------

class _RecordingIndicator extends StatefulWidget {
  final Duration duration;
  final double dragOffset;

  const _RecordingIndicator({
    required this.duration,
    required this.dragOffset,
  });

  @override
  State<_RecordingIndicator> createState() => _RecordingIndicatorState();
}

class _RecordingIndicatorState extends State<_RecordingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController;
  late final Animation<double> _pulseAnimation;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
    _pulseAnimation = Tween<double>(begin: 0.3, end: 1.0).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isCancelling = widget.dragOffset < -60;
    final m = widget.duration.inMinutes.toString().padLeft(2, '0');
    final s = (widget.duration.inSeconds % 60).toString().padLeft(2, '0');

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          // Pulsing red dot with breathing animation
          AnimatedBuilder(
            animation: _pulseAnimation,
            builder: (context, child) {
              return Opacity(
                opacity: _pulseAnimation.value,
                child: Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: AppColors.error,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.error
                            .withOpacity(0.5 * _pulseAnimation.value),
                        blurRadius: 6 + (4 * _pulseAnimation.value),
                        spreadRadius: 1 + (2 * _pulseAnimation.value),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          const SizedBox(width: 10),
          Text(
            '$m:$s',
            style: const TextStyle(
              color: AppColors.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
          const Spacer(),
          AnimatedOpacity(
            opacity: isCancelling ? 1.0 : 0.6,
            duration: const Duration(milliseconds: 150),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.chevron_left,
                  color: isCancelling
                      ? AppColors.error
                      : AppColors.textSecondary,
                  size: 18,
                ),
                const SizedBox(width: 2),
                Text(
                  isCancelling ? 'Release to cancel' : 'Slide to cancel',
                  style: TextStyle(
                    color: isCancelling
                        ? AppColors.error
                        : AppColors.textSecondary,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Message bubble ----------

class _MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final String? serverUrl;
  final String? token;
  final VoidCallback? onRetry;
  final String? agentId;
  final List<SessionSummary> sessions;

  const _MessageBubble({required this.message, this.serverUrl, this.token, this.onRetry, this.agentId, this.sessions = const []});

  @override
  Widget build(BuildContext context) {
    if (message.isLoading) {
      return const _TypingIndicator();
    }

    final isUser = message.isUser;

    if (message.isError) {
      return _ErrorBubble(message: message, onRetry: onRetry);
    }

    // Voice note message gets special rendering.
    if (message.hasVoiceNote) {
      final voiceAtt = message.attachments.firstWhere((a) => a.isVoice);
      return Align(
        alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.72,
          ),
          margin: EdgeInsets.only(
            top: 4,
            bottom: 4,
            left: isUser ? 48 : 0,
            right: isUser ? 0 : 48,
          ),
          child: _VoiceNotePlayer(
            attachment: voiceAtt,
            isUser: isUser,
          ),
        ),
      );
    }

    final bgColor = isUser ? AppColors.userBubble : AppColors.agentBubble;
    final textColor = isUser ? Colors.white : AppColors.textPrimary;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: () {
          Clipboard.setData(ClipboardData(text: message.content));
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Copied to clipboard'),
              duration: Duration(seconds: 1),
            ),
          );
        },
        child: Container(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.78,
          ),
          margin: EdgeInsets.only(
            top: 4,
            bottom: 4,
            left: isUser ? 48 : 0,
            right: isUser ? 0 : 48,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(16),
              topRight: const Radius.circular(16),
              bottomLeft: Radius.circular(isUser ? 16 : 4),
              bottomRight: Radius.circular(isUser ? 4 : 16),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Inline image attachments
              if (message.attachments.any((a) => a.isImage))
                ...message.attachments
                    .where((a) => a.isImage)
                    .map((a) => _InlineImage(
                          attachment: a,
                          serverUrl: serverUrl,
                          token: token,
                        )),

              // File attachment chips
              if (message.attachments.any((a) => a.isFile))
                ...message.attachments
                    .where((a) => a.isFile)
                    .map((a) => _FileChip(attachment: a)),

              // Text content
              if (message.content.isNotEmpty)
                isUser
                    ? SelectableText(
                        message.content,
                        style: TextStyle(
                          color: textColor,
                          fontSize: 14,
                          height: 1.4,
                        ),
                      )
                    : _RichMessageContent(
                        content: message.content,
                        textColor: textColor,
                        agentId: agentId,
                        sessions: sessions,
                      ),

              // Timestamp + status
              const SizedBox(height: 4),
              Align(
                alignment: Alignment.bottomRight,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      DateFormat('HH:mm').format(message.timestamp),
                      style: TextStyle(
                        color: isUser
                            ? Colors.white.withOpacity(0.6)
                            : AppColors.textSecondary,
                        fontSize: 10,
                      ),
                    ),
                    if (isUser) ...[
                      const SizedBox(width: 4),
                      _MessageStatusIcon(
                        status: message.status,
                        color: Colors.white.withOpacity(0.6),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------- Inline image in message ----------

class _InlineImage extends StatelessWidget {
  final ChatAttachment attachment;
  final String? serverUrl;
  final String? token;

  const _InlineImage({
    required this.attachment,
    this.serverUrl,
    this.token,
  });

  /// Build the full URL for remote images served by the gateway.
  String? get _fullUrl {
    if (!attachment.isRemote || serverUrl == null) return null;
    final base = serverUrl!.endsWith('/') ? serverUrl!.substring(0, serverUrl!.length - 1) : serverUrl!;
    return '$base${attachment.url}';
  }

  /// Build auth headers for network image requests.
  Map<String, String> get _headers => {
    if (token != null) 'Authorization': 'Bearer $token',
  };

  Widget _buildImage({BoxFit fit = BoxFit.cover}) {
    if (attachment.isRemote && _fullUrl != null) {
      return Image.network(
        _fullUrl!,
        headers: _headers,
        fit: fit,
        loadingBuilder: (context, child, progress) {
          if (progress == null) return child;
          return Container(
            height: 150,
            color: AppColors.surfaceLight,
            child: Center(
              child: CircularProgressIndicator(
                value: progress.expectedTotalBytes != null
                    ? progress.cumulativeBytesLoaded / progress.expectedTotalBytes!
                    : null,
                strokeWidth: 2,
                color: AppColors.accent,
              ),
            ),
          );
        },
        errorBuilder: (_, __, ___) => _errorWidget(),
      );
    }
    return Image.file(
      File(attachment.path),
      fit: fit,
      errorBuilder: (_, __, ___) => _errorWidget(),
    );
  }

  Widget _errorWidget() => Container(
    height: 80,
    color: AppColors.surfaceLight,
    child: const Center(
      child: Icon(Icons.broken_image,
          color: AppColors.textSecondary, size: 32),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => _showFullImage(context),
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        constraints: const BoxConstraints(maxHeight: 200),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: _buildImage(),
        ),
      ),
    );
  }

  void _showFullImage(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _FullImageViewer(
          attachment: attachment,
          serverUrl: serverUrl,
          token: token,
        ),
      ),
    );
  }
}

// ---------- Full-screen image viewer with download & share ----------

class _FullImageViewer extends StatefulWidget {
  final ChatAttachment attachment;
  final String? serverUrl;
  final String? token;

  const _FullImageViewer({
    required this.attachment,
    this.serverUrl,
    this.token,
  });

  @override
  State<_FullImageViewer> createState() => _FullImageViewerState();
}

class _FullImageViewerState extends State<_FullImageViewer> {
  bool _isSaving = false;
  bool _isSharing = false;

  String? get _fullUrl {
    if (!widget.attachment.isRemote || widget.serverUrl == null) return null;
    final base = widget.serverUrl!.endsWith('/')
        ? widget.serverUrl!.substring(0, widget.serverUrl!.length - 1)
        : widget.serverUrl!;
    return '$base${widget.attachment.url}';
  }

  Map<String, String> get _headers => {
    if (widget.token != null) 'Authorization': 'Bearer ${widget.token}',
  };

  Widget _buildImage({BoxFit fit = BoxFit.cover}) {
    if (widget.attachment.isRemote && _fullUrl != null) {
      return Image.network(
        _fullUrl!,
        headers: _headers,
        fit: fit,
        loadingBuilder: (context, child, progress) {
          if (progress == null) return child;
          return Container(
            height: 150,
            color: AppColors.surfaceLight,
            child: Center(
              child: CircularProgressIndicator(
                value: progress.expectedTotalBytes != null
                    ? progress.cumulativeBytesLoaded /
                        progress.expectedTotalBytes!
                    : null,
                strokeWidth: 2,
                color: AppColors.accent,
              ),
            ),
          );
        },
        errorBuilder: (_, __, ___) => _errorWidget(),
      );
    }
    return Image.file(
      File(widget.attachment.path),
      fit: fit,
      errorBuilder: (_, __, ___) => _errorWidget(),
    );
  }

  Widget _errorWidget() => Container(
    height: 80,
    color: AppColors.surfaceLight,
    child: const Center(
      child: Icon(Icons.broken_image,
          color: AppColors.textSecondary, size: 32),
    ),
  );

  /// Get image bytes - either from network or local file.
  Future<Uint8List?> _getImageBytes() async {
    try {
      if (widget.attachment.isRemote && _fullUrl != null) {
        final dio = Dio();
        final response = await dio.get<List<int>>(
          _fullUrl!,
          options: Options(
            responseType: ResponseType.bytes,
            headers: _headers,
          ),
        );
        return Uint8List.fromList(response.data ?? []);
      } else {
        final file = File(widget.attachment.path);
        if (await file.exists()) {
          return await file.readAsBytes();
        }
      }
    } catch (e) {
      debugPrint('Failed to get image bytes: $e');
    }
    return null;
  }

  /// Save the image to the device gallery.
  Future<void> _downloadImage() async {
    if (_isSaving) return;
    setState(() => _isSaving = true);

    try {
      // Get a temp file path to save the image first.
      final bytes = await _getImageBytes();
      if (bytes == null || bytes.isEmpty) {
        _showSnackBar('Failed to load image data', isError: true);
        return;
      }

      final tempDir = await getTemporaryDirectory();
      final ext = _extensionFromMime(widget.attachment.mimeType);
      final fileName = 'tamerclaw_${DateTime.now().millisecondsSinceEpoch}$ext';
      final tempFile = File('${tempDir.path}/$fileName');
      await tempFile.writeAsBytes(bytes);

      // Save to gallery
      await Gal.putImage(tempFile.path, album: 'TamerClaw');

      // Clean up temp file
      if (await tempFile.exists()) {
        await tempFile.delete();
      }

      if (mounted) {
        _showSnackBar('Image saved to gallery');
      }
    } catch (e) {
      debugPrint('Failed to save image: $e');
      if (mounted) {
        _showSnackBar('Failed to save image: ${e.toString()}', isError: true);
      }
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  /// Share the image using the system share sheet.
  Future<void> _shareImage() async {
    if (_isSharing) return;
    setState(() => _isSharing = true);

    try {
      String filePath;

      if (widget.attachment.isRemote && _fullUrl != null) {
        // Download to temp for sharing
        final bytes = await _getImageBytes();
        if (bytes == null || bytes.isEmpty) {
          _showSnackBar('Failed to load image data', isError: true);
          return;
        }

        final tempDir = await getTemporaryDirectory();
        final ext = _extensionFromMime(widget.attachment.mimeType);
        final fileName =
            'tamerclaw_share_${DateTime.now().millisecondsSinceEpoch}$ext';
        final tempFile = File('${tempDir.path}/$fileName');
        await tempFile.writeAsBytes(bytes);
        filePath = tempFile.path;
      } else {
        filePath = widget.attachment.path;
      }

      final xFile = XFile(filePath, mimeType: widget.attachment.mimeType);
      final result = await Share.shareXFiles(
        [xFile],
        text: widget.attachment.name,
      );

      if (result.status == ShareResultStatus.dismissed) {
        debugPrint('Share dismissed');
      }
    } catch (e) {
      debugPrint('Failed to share image: $e');
      if (mounted) {
        _showSnackBar('Failed to share image: ${e.toString()}', isError: true);
      }
    } finally {
      if (mounted) setState(() => _isSharing = false);
    }
  }

  String _extensionFromMime(String mimeType) {
    switch (mimeType) {
      case 'image/png':
        return '.png';
      case 'image/gif':
        return '.gif';
      case 'image/webp':
        return '.webp';
      case 'image/bmp':
        return '.bmp';
      default:
        return '.jpg';
    }
  }

  void _showSnackBar(String message, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? AppColors.error : AppColors.success,
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: Text(
          widget.attachment.name,
          style: const TextStyle(color: Colors.white, fontSize: 14),
        ),
        actions: [
          // Download button
          IconButton(
            onPressed: _isSaving ? null : _downloadImage,
            tooltip: 'Save to gallery',
            icon: _isSaving
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.download_rounded, color: Colors.white),
          ),
          // Share button
          IconButton(
            onPressed: _isSharing ? null : _shareImage,
            tooltip: 'Share image',
            icon: _isSharing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.share_rounded, color: Colors.white),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: Center(
        child: InteractiveViewer(
          child: _buildImage(fit: BoxFit.contain),
        ),
      ),
    );
  }
}

// ---------- File chip in message ----------

class _FileChip extends StatelessWidget {
  final ChatAttachment attachment;

  const _FileChip({required this.attachment});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight.withOpacity(0.5),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.insert_drive_file,
              color: AppColors.accent, size: 18),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  attachment.name,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  attachment.sizeLabel,
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Voice note player ----------

class _VoiceNotePlayer extends StatefulWidget {
  final ChatAttachment attachment;
  final bool isUser;

  const _VoiceNotePlayer({
    required this.attachment,
    required this.isUser,
  });

  @override
  State<_VoiceNotePlayer> createState() => _VoiceNotePlayerState();
}

class _VoiceNotePlayerState extends State<_VoiceNotePlayer>
    with SingleTickerProviderStateMixin {
  final _player = AudioPlayer();
  bool _isPlaying = false;
  bool _isLoading = false;
  String? _error;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;
  late AnimationController _waveController;

  // Pre-generated random bar heights for the waveform visualization.
  late final List<double> _barHeights;

  @override
  void initState() {
    super.initState();
    _waveController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );

    // Generate consistent pseudo-random bar heights.
    final rng = Random(widget.attachment.name.hashCode);
    _barHeights = List.generate(28, (_) => 0.3 + rng.nextDouble() * 0.7);

    _player.onDurationChanged.listen((d) {
      if (mounted) setState(() => _duration = d);
    });
    _player.onPositionChanged.listen((p) {
      if (mounted) setState(() => _position = p);
    });
    _player.onPlayerComplete.listen((_) {
      if (mounted) {
        setState(() {
          _isPlaying = false;
          _position = Duration.zero;
        });
        _waveController.stop();
      }
    });

    // Validate that the audio file exists locally
    _validateSource();
  }

  Future<void> _validateSource() async {
    final file = File(widget.attachment.path);
    if (!await file.exists()) {
      if (mounted) {
        setState(() => _error = 'Audio file not available');
      }
    }
  }

  @override
  void dispose() {
    _player.dispose();
    _waveController.dispose();
    super.dispose();
  }

  Future<void> _togglePlay() async {
    if (_error != null) return;

    if (_isPlaying) {
      await _player.pause();
      _waveController.stop();
      setState(() => _isPlaying = false);
    } else {
      try {
        setState(() => _isLoading = true);
        if (_position == Duration.zero || _position >= _duration) {
          await _player.play(DeviceFileSource(widget.attachment.path));
        } else {
          await _player.resume();
        }
        _waveController.repeat(reverse: true);
        if (mounted) setState(() { _isPlaying = true; _isLoading = false; });
      } catch (e) {
        if (mounted) {
          setState(() {
            _isLoading = false;
            _error = 'Could not play audio';
          });
        }
      }
    }
  }

  String _formatDuration(Duration d) {
    final m = d.inMinutes.toString().padLeft(2, '0');
    final s = (d.inSeconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final bgColor =
        widget.isUser ? AppColors.userBubble : AppColors.agentBubble;
    final fgColor = widget.isUser ? Colors.white : AppColors.textPrimary;
    final secondaryColor =
        widget.isUser ? Colors.white70 : AppColors.textSecondary;
    final progressFraction =
        _duration.inMilliseconds > 0
            ? (_position.inMilliseconds / _duration.inMilliseconds)
                .clamp(0.0, 1.0)
            : 0.0;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(16),
          topRight: const Radius.circular(16),
          bottomLeft: Radius.circular(widget.isUser ? 16 : 4),
          bottomRight: Radius.circular(widget.isUser ? 4 : 16),
        ),
      ),
      child: _error != null
          ? Row(
              children: [
                Icon(Icons.error_outline, color: secondaryColor, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: secondaryColor,
                      fontSize: 12,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
                ),
              ],
            )
          : Row(
              children: [
                // Play / pause / loading
                GestureDetector(
                  onTap: _togglePlay,
                  child: Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: fgColor.withOpacity(0.15),
                      shape: BoxShape.circle,
                    ),
                    child: _isLoading
                        ? Padding(
                            padding: const EdgeInsets.all(10),
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: fgColor,
                            ),
                          )
                        : Icon(
                            _isPlaying ? Icons.pause : Icons.play_arrow,
                            color: fgColor,
                            size: 22,
                          ),
                  ),
                ),
                const SizedBox(width: 10),

                // Waveform bars
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        height: 28,
                        child: AnimatedBuilder(
                          animation: _waveController,
                          builder: (context, _) {
                            return CustomPaint(
                              size: const Size(double.infinity, 28),
                              painter: _WaveformPainter(
                                barHeights: _barHeights,
                                progress: progressFraction,
                                activeColor: fgColor,
                                inactiveColor: fgColor.withOpacity(0.25),
                                animValue: _isPlaying ? _waveController.value : 0,
                              ),
                            );
                          },
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _isPlaying || _position > Duration.zero
                            ? _formatDuration(_position)
                            : _formatDuration(_duration),
                        style: TextStyle(
                          color: secondaryColor,
                          fontSize: 11,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}

// ---------- Waveform painter ----------

class _WaveformPainter extends CustomPainter {
  final List<double> barHeights;
  final double progress;
  final Color activeColor;
  final Color inactiveColor;
  final double animValue;

  _WaveformPainter({
    required this.barHeights,
    required this.progress,
    required this.activeColor,
    required this.inactiveColor,
    required this.animValue,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final barCount = barHeights.length;
    final totalGapWidth = (barCount - 1) * 2.0;
    final barWidth = (size.width - totalGapWidth) / barCount;
    final activePaint = Paint()..color = activeColor;
    final inactivePaint = Paint()..color = inactiveColor;

    for (int i = 0; i < barCount; i++) {
      final fraction = i / barCount;
      final isActive = fraction <= progress;

      // Subtle animation on the currently-playing bar area.
      var h = barHeights[i];
      if (animValue > 0 && isActive && (fraction > progress - 0.1)) {
        h = (h + animValue * 0.15).clamp(0.3, 1.0);
      }

      final barHeight = max(4.0, h * size.height);
      final x = i * (barWidth + 2.0);
      final y = (size.height - barHeight) / 2;

      final rect = RRect.fromRectAndRadius(
        Rect.fromLTWH(x, y, barWidth, barHeight),
        const Radius.circular(1.5),
      );
      canvas.drawRRect(rect, isActive ? activePaint : inactivePaint);
    }
  }

  @override
  bool shouldRepaint(covariant _WaveformPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.animValue != animValue;
}

// ---------- Rich message content with code blocks ----------

class _RichMessageContent extends StatelessWidget {
  final String content;
  final Color textColor;
  final String? agentId;
  final List<SessionSummary> sessions;

  const _RichMessageContent({required this.content, required this.textColor, this.agentId, this.sessions = const []});

  @override
  Widget build(BuildContext context) {
    final segments = _parseCodeBlocks(content);

    if (segments.length == 1 && !segments.first.isCode) {
      return _buildMarkdownText(content);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: segments.map((seg) {
        if (seg.isCode) {
          return _CodeBlock(code: seg.content, language: seg.language);
        }
        return _buildMarkdownText(seg.content);
      }).toList(),
    );
  }

  /// Builds a widget for text that may contain basic markdown:
  /// **bold**, *italic*, and bullet lists (lines starting with `- ` or `* `).
  Widget _buildMarkdownText(String text) {
    final lines = text.split('\n');
    final List<Widget> widgets = [];
    final List<String> paragraphLines = [];

    void flushParagraph() {
      if (paragraphLines.isEmpty) return;
      final joined = paragraphLines.join('\n');
      widgets.add(
        SelectableText.rich(
          _parseInlineMarkdown(joined),
          style: TextStyle(color: textColor, fontSize: 14, height: 1.4),
        ),
      );
      paragraphLines.clear();
    }

    // Regex to detect session lines like "Chat 984900 — 12 msgs"
    final sessionPattern = RegExp(r'Chat\s+(\w{6})\s*[—–-]');

    for (final line in lines) {
      final trimmed = line.trimLeft();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('\u2022 ')) {
        flushParagraph();
        final bulletText = trimmed.startsWith('\u2022 ')
            ? trimmed.substring(2)
            : trimmed.substring(2);

        // Check if this is a session line
        final sessionMatch = sessionPattern.firstMatch(bulletText);
        if (sessionMatch != null && agentId != null) {
          final shortId = sessionMatch.group(1)!;
          // Find full chatId from sessions list
          final fullChatId = _resolveSessionId(shortId);
          widgets.add(
            Builder(builder: (ctx) {
              return Padding(
                padding: const EdgeInsets.only(left: 4, top: 3, bottom: 3),
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(10),
                    onTap: fullChatId != null
                        ? () => GoRouter.of(ctx).push(
                              '/chat/$agentId?chatId=$fullChatId',
                            )
                        : null,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: AppColors.userBubble.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: AppColors.userBubble.withOpacity(0.3),
                          width: 1,
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.chat_bubble_outline, size: 18, color: AppColors.userBubble),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              bulletText,
                              style: TextStyle(color: textColor, fontSize: 13.5, height: 1.4),
                            ),
                          ),
                          Icon(Icons.chevron_right, size: 20, color: textColor.withOpacity(0.5)),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            }),
          );
        } else {
          widgets.add(
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 2, bottom: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '\u2022 ',
                    style: TextStyle(color: textColor, fontSize: 14, height: 1.4),
                  ),
                  Expanded(
                    child: SelectableText.rich(
                      _parseInlineMarkdown(bulletText),
                      style: TextStyle(
                          color: textColor, fontSize: 14, height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
          );
        }
      } else {
        paragraphLines.add(line);
      }
    }
    flushParagraph();

    if (widgets.length == 1) return widgets.first;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: widgets,
    );
  }

  /// Resolves a 6-char short session ID back to the full chatId.
  String? _resolveSessionId(String shortId) {
    for (final s in sessions) {
      if (s.chatId.endsWith(shortId)) return s.chatId;
    }
    // If no match in loaded sessions, return null
    return null;
  }

  /// Parses **bold** and *italic* inline markdown into a [TextSpan] tree.
  TextSpan _parseInlineMarkdown(String text) {
    final spans = <InlineSpan>[];
    // Match **bold** first, then *italic*
    final regex = RegExp(r'\*\*(.+?)\*\*|\*(.+?)\*');
    int lastEnd = 0;

    for (final match in regex.allMatches(text)) {
      if (match.start > lastEnd) {
        spans.add(TextSpan(text: text.substring(lastEnd, match.start)));
      }
      if (match.group(1) != null) {
        // Bold
        spans.add(TextSpan(
          text: match.group(1),
          style: const TextStyle(fontWeight: FontWeight.w700),
        ));
      } else if (match.group(2) != null) {
        // Italic
        spans.add(TextSpan(
          text: match.group(2),
          style: const TextStyle(fontStyle: FontStyle.italic),
        ));
      }
      lastEnd = match.end;
    }
    if (lastEnd < text.length) {
      spans.add(TextSpan(text: text.substring(lastEnd)));
    }
    if (spans.isEmpty) {
      return TextSpan(text: text);
    }
    return TextSpan(children: spans);
  }

  static List<_TextSegment> _parseCodeBlocks(String text) {
    final segments = <_TextSegment>[];
    final regex = RegExp(r'```(\w*)\n?([\s\S]*?)```', multiLine: true);

    int lastEnd = 0;
    for (final match in regex.allMatches(text)) {
      if (match.start > lastEnd) {
        final before = text.substring(lastEnd, match.start).trim();
        if (before.isNotEmpty) {
          segments.add(_TextSegment(content: before, isCode: false));
        }
      }
      segments.add(_TextSegment(
        content: match.group(2)?.trim() ?? '',
        isCode: true,
        language: match.group(1) ?? '',
      ));
      lastEnd = match.end;
    }

    if (lastEnd < text.length) {
      final rest = text.substring(lastEnd).trim();
      if (rest.isNotEmpty) {
        segments.add(_TextSegment(content: rest, isCode: false));
      }
    }

    if (segments.isEmpty) {
      segments.add(_TextSegment(content: text, isCode: false));
    }

    return segments;
  }
}

class _TextSegment {
  final String content;
  final bool isCode;
  final String language;

  const _TextSegment({
    required this.content,
    required this.isCode,
    this.language = '',
  });
}

class _CodeBlock extends StatelessWidget {
  final String code;
  final String language;

  const _CodeBlock({required this.code, this.language = ''});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.codeBackground,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.surfaceLight, width: 0.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header with language label and copy button
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: const BoxDecoration(
              border: Border(
                bottom:
                    BorderSide(color: AppColors.surfaceLight, width: 0.5),
              ),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  language.isNotEmpty ? language : 'code',
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Code copied'),
                        duration: Duration(seconds: 1),
                      ),
                    );
                  },
                  child: const Icon(
                    Icons.copy,
                    size: 14,
                    color: AppColors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          // Code content
          Padding(
            padding: const EdgeInsets.all(10),
            child: SelectableText(
              code,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12.5,
                height: 1.5,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Typing indicator (three dots animation) ----------

class _TypingIndicator extends StatefulWidget {
  const _TypingIndicator();

  @override
  State<_TypingIndicator> createState() => _TypingIndicatorState();
}

class _TypingIndicatorState extends State<_TypingIndicator>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: const BoxDecoration(
          color: AppColors.agentBubble,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
        ),
        child: AnimatedBuilder(
          animation: _controller,
          builder: (context, _) {
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(3, (index) {
                final delay = index * 0.2;
                final t = (_controller.value - delay).clamp(0.0, 1.0);
                final bounce = (t < 0.5) ? t * 2 : 2 - t * 2;
                return Container(
                  width: 8,
                  height: 8,
                  margin: EdgeInsets.only(right: index < 2 ? 4 : 0),
                  decoration: BoxDecoration(
                    color: AppColors.textSecondary
                        .withOpacity(0.4 + bounce * 0.6),
                    shape: BoxShape.circle,
                  ),
                );
              }),
            );
          },
        ),
      ),
    );
  }
}

// ---------- Message status icon ----------

class _MessageStatusIcon extends StatelessWidget {
  final MessageStatus status;
  final Color color;

  const _MessageStatusIcon({required this.status, required this.color});

  @override
  Widget build(BuildContext context) {
    switch (status) {
      case MessageStatus.sending:
        return Icon(Icons.access_time, size: 12, color: color);
      case MessageStatus.sent:
        return Icon(Icons.check, size: 12, color: color);
      case MessageStatus.delivered:
        return Icon(Icons.done_all, size: 12, color: color);
      case MessageStatus.read:
        return const Icon(Icons.done_all, size: 12, color: AppColors.accent);
      case MessageStatus.error:
        return const Icon(Icons.error_outline, size: 12, color: AppColors.error);
    }
  }
}

// ---------- Error bubble with retry ----------

class _ErrorBubble extends StatelessWidget {
  final ChatMessage message;
  final VoidCallback? onRetry;

  const _ErrorBubble({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.78,
        ),
        margin: const EdgeInsets.only(top: 4, bottom: 4, right: 48),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.error.withOpacity(0.12),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(16),
          ),
          border: Border.all(color: AppColors.error.withOpacity(0.3)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline,
                    color: AppColors.error, size: 16),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    message.content,
                    style: const TextStyle(
                      color: AppColors.error,
                      fontSize: 13,
                      height: 1.3,
                    ),
                  ),
                ),
              ],
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 8),
              GestureDetector(
                onTap: onRetry,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                  decoration: BoxDecoration(
                    color: AppColors.error.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.refresh, color: AppColors.error, size: 14),
                      SizedBox(width: 4),
                      Text(
                        'Retry',
                        style: TextStyle(
                          color: AppColors.error,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ---------- Mini pulse dot for agent activity ----------

class _MiniPulse extends StatefulWidget {
  const _MiniPulse();

  @override
  State<_MiniPulse> createState() => _MiniPulseState();
}

class _MiniPulseState extends State<_MiniPulse>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            color: AppColors.online.withOpacity(0.5 + _controller.value * 0.5),
            shape: BoxShape.circle,
          ),
        );
      },
    );
  }
}
