import 'dart:async';
import 'dart:collection';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:tamerclaw_mobile/core/api/api_client.dart';
import 'package:tamerclaw_mobile/core/api/api_endpoints.dart';
import 'package:tamerclaw_mobile/features/auth/auth_provider.dart';
import 'package:tamerclaw_mobile/shared/models/message.dart';

final chatProvider =
    StateNotifierProvider.family<ChatNotifier, ChatState, String>((ref, agentId) {
  final api = ref.watch(apiClientProvider);
  return ChatNotifier(api, agentId);
});

enum AgentActivityStatus { idle, receiving, thinking, working, broadcasting }

class ChatState {
  final List<ChatMessage> messages;
  final bool isSending;
  final int pendingMessages; // Number of queued messages waiting to send
  final String? currentChatId;
  final List<SessionSummary> sessions;
  final bool isLoadingSessions;
  final bool isLoadingHistory;
  final bool isPolling;
  final String? pollingError;
  final AgentActivityStatus agentStatus;

  const ChatState({
    this.messages = const [],
    this.isSending = false,
    this.pendingMessages = 0,
    this.currentChatId,
    this.sessions = const [],
    this.isLoadingSessions = false,
    this.isLoadingHistory = false,
    this.isPolling = false,
    this.pollingError,
    this.agentStatus = AgentActivityStatus.idle,
  });

  /// Whether the agent is actively processing (not idle).
  bool get isAgentBusy => agentStatus != AgentActivityStatus.idle || isSending;

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? isSending,
    int? pendingMessages,
    String? currentChatId,
    List<SessionSummary>? sessions,
    bool? isLoadingSessions,
    bool? isLoadingHistory,
    bool? isPolling,
    String? pollingError,
    AgentActivityStatus? agentStatus,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      isSending: isSending ?? this.isSending,
      pendingMessages: pendingMessages ?? this.pendingMessages,
      currentChatId: currentChatId ?? this.currentChatId,
      sessions: sessions ?? this.sessions,
      isLoadingSessions: isLoadingSessions ?? this.isLoadingSessions,
      isLoadingHistory: isLoadingHistory ?? this.isLoadingHistory,
      isPolling: isPolling ?? this.isPolling,
      pollingError: pollingError,
      agentStatus: agentStatus ?? this.agentStatus,
    );
  }

  String get agentStatusText {
    switch (agentStatus) {
      case AgentActivityStatus.idle:
        return '';
      case AgentActivityStatus.receiving:
        return 'Receiving...';
      case AgentActivityStatus.thinking:
        return 'Thinking...';
      case AgentActivityStatus.working:
        return 'Working...';
      case AgentActivityStatus.broadcasting:
        return 'Responding...';
    }
  }
}

/// Queued message waiting to be sent.
class _QueuedMessage {
  final String text;
  final List<ChatAttachment> attachments;
  final String userMessageId;

  _QueuedMessage({
    required this.text,
    required this.attachments,
    required this.userMessageId,
  });
}

/// Callback type for new-message notifications (used by push notification service).
typedef OnNewMessageCallback = void Function(String agentId, ChatMessage message);

/// Global callback for push notification integration.
/// Set this from the notification service to get notified of new polled messages.
OnNewMessageCallback? onNewMessageReceived;

class ChatNotifier extends StateNotifier<ChatState> {
  final ApiClient? _api;
  final String agentId;
  String? _lastFailedText;
  Timer? _pollTimer;
  Timer? _activityPollTimer;
  DateTime? _lastPollTimestamp;
  bool _pollActive = false;

  // Message queue for sequential sending
  final Queue<_QueuedMessage> _messageQueue = Queue();
  bool _isProcessingQueue = false;

  ChatNotifier(this._api, this.agentId) : super(const ChatState());

  String? get lastFailedText => _lastFailedText;
  bool get isConnected => _api != null;

  /// Generate a new chat ID in the server's expected format.
  String _generateChatId() => 'api_${DateTime.now().millisecondsSinceEpoch}';

  /// Start a brand new chat session, clearing existing messages.
  void startNewChat() {
    _lastFailedText = null;
    _messageQueue.clear();
    _isProcessingQueue = false;
    stopPolling();
    state = ChatState(
      currentChatId: _generateChatId(),
      sessions: state.sessions,
    );
  }

  // ── Polling for 2-way communication ──

  /// Start polling for new messages every [intervalSeconds].
  void startPolling({int intervalSeconds = 3}) {
    if (_api == null || _pollActive) return;
    _pollActive = true;
    state = state.copyWith(isPolling: true);

    // Set initial poll timestamp to now (we only want new messages)
    _lastPollTimestamp ??= DateTime.now();

    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(
      Duration(seconds: intervalSeconds),
      (_) => _pollForMessages(),
    );

    // Also poll for agent activity status (slightly faster interval)
    _activityPollTimer?.cancel();
    _activityPollTimer = Timer.periodic(
      const Duration(seconds: 2),
      (_) => _pollForActivity(),
    );
  }

  /// Stop the polling timer.
  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _activityPollTimer?.cancel();
    _activityPollTimer = null;
    _pollActive = false;
    if (mounted) {
      state = state.copyWith(isPolling: false);
    }
  }

  /// Poll the server for new messages in the current chat session.
  Future<void> _pollForMessages() async {
    if (_api == null || !_pollActive) return;
    final chatId = state.currentChatId;
    if (chatId == null) return;

    try {
      final since = _lastPollTimestamp?.toUtc().toIso8601String();
      final response = await _api.get(
        ApiEndpoints.pollMessages(agentId, chatId: chatId, since: since),
      );

      if (response is! Map) return;
      final hasNew = response['hasNew'] == true;
      if (!hasNew) return;

      final List<dynamic> newMessages = response['messages'] as List<dynamic>? ?? [];
      if (newMessages.isEmpty) return;

      // Add new messages that aren't already in our local state
      final existingIds = state.messages.map((m) => m.id).toSet();
      final existingContents = state.messages
          .where((m) => !m.isLoading && !m.isError)
          .map((m) => '${m.isUser ? "user" : "agent"}_${m.content.hashCode}')
          .toSet();

      final messagesToAdd = <ChatMessage>[];
      for (final msg in newMessages) {
        if (msg is! Map<String, dynamic>) continue;
        final role = msg['role']?.toString() ?? '';
        final content = msg['content']?.toString() ?? '';
        final timestamp = DateTime.tryParse(msg['timestamp']?.toString() ?? '') ??
            DateTime.now();
        final isUser = role == 'user';

        // Deduplicate by content+role hash
        final contentKey = '${isUser ? "user" : "agent"}_${content.hashCode}';
        if (existingContents.contains(contentKey)) continue;

        final id = '${role}_poll_${timestamp.millisecondsSinceEpoch}';
        if (existingIds.contains(id)) continue;

        // Parse media from polled messages
        final pollMediaAttachments = <ChatAttachment>[];
        if (msg['media'] is List) {
          for (final item in msg['media'] as List) {
            if (item is Map<String, dynamic>) {
              pollMediaAttachments.add(ChatAttachment.fromMediaJson(item));
            }
          }
        }

        final newMsg = ChatMessage(
          id: id,
          content: content,
          isUser: isUser,
          timestamp: timestamp,
          status: MessageStatus.delivered,
          attachments: pollMediaAttachments,
        );
        messagesToAdd.add(newMsg);
        existingContents.add(contentKey);

        // Notify push notification service of new agent messages
        if (!isUser && onNewMessageReceived != null) {
          onNewMessageReceived!(agentId, newMsg);
        }
      }

      if (messagesToAdd.isNotEmpty) {
        state = state.copyWith(
          messages: [...state.messages, ...messagesToAdd],
        );
        // Update poll timestamp to the latest message
        final latestTimestamp = messagesToAdd
            .map((m) => m.timestamp)
            .reduce((a, b) => a.isAfter(b) ? a : b);
        _lastPollTimestamp = latestTimestamp;
      }
    } catch (_) {
      // Silently ignore poll errors — don't disrupt the UI
    }
  }

  /// Poll server for real agent activity status.
  Future<void> _pollForActivity() async {
    if (_api == null || !_pollActive) return;

    try {
      final response = await _api.get(
        ApiEndpoints.agentActivity(agentId),
      );

      if (response is! Map) return;
      final serverStatus = response['status']?.toString() ?? 'idle';

      final AgentActivityStatus mapped = switch (serverStatus) {
        'thinking' => AgentActivityStatus.thinking,
        'working' => AgentActivityStatus.working,
        'responding' => AgentActivityStatus.broadcasting,
        _ => AgentActivityStatus.idle,
      };

      if (mounted && state.agentStatus != mapped) {
        state = state.copyWith(agentStatus: mapped);
      }
    } catch (_) {
      // Silently ignore activity poll errors
    }
  }

  // ── Session management ──

  /// Load list of sessions for this agent.
  Future<void> loadSessions() async {
    if (_api == null) return;

    state = state.copyWith(isLoadingSessions: true);

    try {
      final response = await _api.get(ApiEndpoints.agentSessions(agentId));
      final List<dynamic> sessionsList =
          (response is Map ? response['sessions'] : response) as List<dynamic>? ?? [];

      final sessions = sessionsList
          .whereType<Map<String, dynamic>>()
          .map((json) => SessionSummary.fromJson(json))
          .toList();

      // Sort by last activity descending (most recent first).
      sessions.sort((a, b) {
        final aTime = DateTime.tryParse(a.lastActivity ?? '') ?? DateTime(2000);
        final bTime = DateTime.tryParse(b.lastActivity ?? '') ?? DateTime(2000);
        return bTime.compareTo(aTime);
      });

      state = state.copyWith(sessions: sessions, isLoadingSessions: false);
    } catch (e) {
      state = state.copyWith(isLoadingSessions: false);
    }
  }

  /// Delete a session by chatId. Removes it from the local list too.
  Future<bool> deleteSession(String chatId) async {
    if (_api == null) return false;
    try {
      await _api.delete(ApiEndpoints.deleteSession(agentId, chatId));
    } catch (_) {
      // Server may not support DELETE yet — still remove locally
    }
    state = state.copyWith(
      sessions: state.sessions.where((s) => s.chatId != chatId).toList(),
    );
    // If we deleted the currently open session, clear it
    if (state.currentChatId == chatId) {
      clearMessages();
    }
    return true;
  }

  /// Load a specific session's message history.
  Future<void> loadSession(String chatId) async {
    if (_api == null) return;

    stopPolling();
    state = state.copyWith(
      isLoadingHistory: true,
      currentChatId: chatId,
      messages: [],
    );

    try {
      final response =
          await _api.get(ApiEndpoints.sessionHistory(agentId, chatId));

      final List<dynamic> messagesList =
          (response is Map ? response['messages'] : null) as List<dynamic>? ?? [];

      final messages = <ChatMessage>[];
      for (int i = 0; i < messagesList.length; i++) {
        final msg = messagesList[i];
        if (msg is! Map<String, dynamic>) continue;

        final role = msg['role']?.toString() ?? '';
        final content = msg['content']?.toString() ?? '';
        final timestamp = DateTime.tryParse(msg['timestamp']?.toString() ?? '') ??
            DateTime.now();

        // Parse media from history messages
        final historyMediaAttachments = <ChatAttachment>[];
        if (msg['media'] is List) {
          for (final item in msg['media'] as List) {
            if (item is Map<String, dynamic>) {
              historyMediaAttachments.add(ChatAttachment.fromMediaJson(item));
            }
          }
        }

        messages.add(ChatMessage(
          id: '${role}_history_$i',
          content: content,
          isUser: role == 'user',
          timestamp: timestamp,
          status: MessageStatus.delivered,
          attachments: historyMediaAttachments,
        ));
      }

      // Set poll timestamp to the latest message so we only get new ones
      if (messages.isNotEmpty) {
        _lastPollTimestamp = messages.last.timestamp;
      }

      state = state.copyWith(
        messages: messages,
        isLoadingHistory: false,
        currentChatId: chatId,
      );

      // Start polling after loading history
      startPolling();
    } catch (e) {
      state = state.copyWith(isLoadingHistory: false);
    }
  }

  // ── Messaging with Queue ──

  /// Cycle the agent status indicator during long requests.
  Timer? _statusCycleTimer;

  void _startStatusCycle() {
    _statusCycleTimer?.cancel();
    if (mounted) {
      state = state.copyWith(agentStatus: AgentActivityStatus.receiving);
    }
    int tick = 0;
    _statusCycleTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      tick++;
      if (!mounted) {
        _statusCycleTimer?.cancel();
        return;
      }
      switch (tick % 3) {
        case 0:
          state = state.copyWith(agentStatus: AgentActivityStatus.thinking);
          break;
        case 1:
          state = state.copyWith(agentStatus: AgentActivityStatus.working);
          break;
        case 2:
          state = state.copyWith(agentStatus: AgentActivityStatus.broadcasting);
          break;
      }
    });
  }

  void _stopStatusCycle() {
    _statusCycleTimer?.cancel();
    _statusCycleTimer = null;
    if (mounted) {
      state = state.copyWith(agentStatus: AgentActivityStatus.idle);
    }
  }

  /// Send a message. The message is queued and sent sequentially.
  /// The UI is NOT blocked — users can keep typing and sending.
  Future<void> sendMessage(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async {
    if (_api == null) return;
    if (text.trim().isEmpty && attachments.isEmpty) return;
    _lastFailedText = null;

    // Ensure we have a chatId for this conversation.
    final chatId = state.currentChatId ?? _generateChatId();
    if (state.currentChatId == null) {
      state = state.copyWith(currentChatId: chatId);
    }

    // For voice-only messages (no text), use a descriptive placeholder.
    final hasVoice = attachments.any((a) => a.type == AttachmentType.voice);
    final displayText = text.trim().isEmpty && hasVoice
        ? '[Voice Note]'
        : text.trim();

    final userMessageId = 'user_${DateTime.now().millisecondsSinceEpoch}';
    final userMessage = ChatMessage(
      id: userMessageId,
      content: displayText,
      isUser: true,
      timestamp: DateTime.now(),
      attachments: attachments,
      status: MessageStatus.sending,
    );

    // Add user message to UI immediately — no blocking
    state = state.copyWith(
      messages: [...state.messages, userMessage],
      pendingMessages: state.pendingMessages + 1,
    );

    // Queue the message for sequential processing
    _messageQueue.add(_QueuedMessage(
      text: text,
      attachments: attachments,
      userMessageId: userMessageId,
    ));

    // Process queue if not already running
    _processQueue();
  }

  /// Process queued messages one at a time.
  Future<void> _processQueue() async {
    if (_isProcessingQueue || _messageQueue.isEmpty) return;
    _isProcessingQueue = true;

    while (_messageQueue.isNotEmpty) {
      final queued = _messageQueue.removeFirst();

      if (mounted) {
        state = state.copyWith(isSending: true);
      }

      // Start cycling through activity statuses (will be replaced by real
      // server status via activity polling once the async POST returns)
      _startStatusCycle();

      final chatId = state.currentChatId!;
      final hasVoice = queued.attachments.any((a) => a.type == AttachmentType.voice);
      final sendText = queued.text.trim().isEmpty && hasVoice
          ? '[Voice message attached]'
          : queued.text.trim();

      try {
        final dynamic response;

        if (queued.attachments.isNotEmpty) {
          final multipartFiles = <http.MultipartFile>[];
          for (final attachment in queued.attachments) {
            final file = File(attachment.path);
            if (await file.exists()) {
              multipartFiles.add(
                await http.MultipartFile.fromPath(
                  'files',
                  attachment.path,
                  filename: attachment.name,
                ),
              );
            }
          }
          response = await _api!.postMultipart(
            ApiEndpoints.agentMessage(agentId),
            {'message': sendText, 'chatId': chatId, 'fireAndForget': 'true'},
            multipartFiles,
          );
        } else {
          response = await _api!.post(
            ApiEndpoints.agentMessage(agentId),
            {'message': sendText, 'chatId': chatId, 'fireAndForget': 'true'},
          );
        }

        // Async mode: server returns { queued: true } immediately.
        // The agent response will arrive via the polling mechanism.
        final isQueued = response is Map && response['queued'] == true;

        if (isQueued) {
          // Stop the local status cycle — the activity poller will show real status
          _stopStatusCycle();

          // Mark user message as sent (not delivered yet — delivery confirmed via poll)
          if (mounted) {
            final updatedMessages = state.messages.map((m) {
              if (m.id == queued.userMessageId) {
                return m.copyWith(status: MessageStatus.sent);
              }
              return m;
            }).toList();

            state = state.copyWith(
              messages: updatedMessages,
              isSending: false,
              pendingMessages: (state.pendingMessages - 1).clamp(0, 999),
            );
          }
        } else {
          // Fallback: server returned a synchronous response (old behavior)
          _stopStatusCycle();

          final responseText = response is Map
              ? (response['response'] ??
                      response['message'] ??
                      response['data'] ??
                      'No response')
                  .toString()
              : response.toString();

          // Parse media attachments from response
          final mediaAttachments = <ChatAttachment>[];
          if (response is Map && response['media'] is List) {
            for (final item in response['media'] as List) {
              if (item is Map<String, dynamic>) {
                mediaAttachments.add(ChatAttachment.fromMediaJson(item));
              }
            }
          }

          final agentMessage = ChatMessage(
            id: 'agent_${DateTime.now().millisecondsSinceEpoch}',
            content: responseText,
            isUser: false,
            timestamp: DateTime.now(),
            status: MessageStatus.delivered,
            attachments: mediaAttachments,
          );

          // Mark the user message as delivered and add agent response.
          if (mounted) {
            final messages = state.messages.where((m) => !m.isLoading).toList();
            final updatedMessages = messages.map((m) {
              if (m.id == queued.userMessageId) {
                return m.copyWith(status: MessageStatus.delivered);
              }
              return m;
            }).toList();

            _lastPollTimestamp = DateTime.now();

            state = state.copyWith(
              messages: [...updatedMessages, agentMessage],
              pendingMessages: (state.pendingMessages - 1).clamp(0, 999),
            );
          }
        }

        // Reload sessions after /sessions command
        if (queued.text.trim() == '/sessions') {
          loadSessions();
        }

        // Start polling if not already active
        if (!_pollActive) startPolling();
      } catch (e) {
        _stopStatusCycle();
        _lastFailedText = queued.text.trim();

        final errorMessage = ChatMessage(
          id: 'error_${DateTime.now().millisecondsSinceEpoch}',
          content: e.toString(),
          isUser: false,
          timestamp: DateTime.now(),
          isError: true,
          errorDetail: e.toString(),
          status: MessageStatus.error,
        );

        if (mounted) {
          final messages = state.messages.where((m) => !m.isLoading).toList();
          final updatedMessages = messages.map((m) {
            if (m.id == queued.userMessageId) {
              return m.copyWith(status: MessageStatus.error);
            }
            return m;
          }).toList();
          state = state.copyWith(
            messages: [...updatedMessages, errorMessage],
            pendingMessages: (state.pendingMessages - 1).clamp(0, 999),
          );
        }
      }
    }

    _isProcessingQueue = false;
    if (mounted) {
      state = state.copyWith(isSending: false);
    }
  }

  /// Stop the agent — kills the active Claude CLI process on the server.
  Future<bool> stopAgent() async {
    if (_api == null) return false;

    try {
      final response = await _api.post(
        ApiEndpoints.stopAgent(agentId),
        {'chatId': state.currentChatId ?? ''},
      );

      final stopped = response is Map && response['stopped'] == true;

      if (stopped) {
        // Clear the message queue
        _messageQueue.clear();
        _stopStatusCycle();

        // Remove any loading messages and update state
        if (mounted) {
          final messages = state.messages.where((m) => !m.isLoading).toList();

          final stoppedMessage = ChatMessage(
            id: 'system_${DateTime.now().millisecondsSinceEpoch}',
            content: 'Agent stopped.',
            isUser: false,
            timestamp: DateTime.now(),
            status: MessageStatus.delivered,
          );

          state = state.copyWith(
            messages: [...messages, stoppedMessage],
            isSending: false,
            pendingMessages: 0,
            agentStatus: AgentActivityStatus.idle,
          );
        }
      }

      return stopped;
    } catch (e) {
      return false;
    }
  }

  void clearMessages() {
    stopPolling();
    _messageQueue.clear();
    _isProcessingQueue = false;
    state = ChatState(
      sessions: state.sessions,
    );
    _lastFailedText = null;
    _lastPollTimestamp = null;
  }

  Future<void> retry() async {
    if (_lastFailedText == null) return;
    // Remove the last error message before retrying
    final cleaned =
        state.messages.where((m) => !m.isError || m.id != state.messages.last.id).toList();
    state = state.copyWith(messages: cleaned);
    await sendMessage(_lastFailedText!);
  }

  @override
  void dispose() {
    stopPolling();
    _statusCycleTimer?.cancel();
    _activityPollTimer?.cancel();
    super.dispose();
  }
}
