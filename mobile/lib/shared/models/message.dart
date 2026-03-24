enum MessageStatus { sending, sent, delivered, read, error }

class SessionSummary {
  final String chatId;
  final int messageCount;
  final String? lastActivity;
  final String? startedAt;
  final String? summary;
  final String? preview;

  const SessionSummary({
    required this.chatId,
    required this.messageCount,
    this.lastActivity,
    this.startedAt,
    this.summary,
    this.preview,
  });

  factory SessionSummary.fromJson(Map<String, dynamic> json) {
    return SessionSummary(
      chatId: json['chatId']?.toString() ?? '',
      messageCount: json['messageCount'] as int? ?? 0,
      lastActivity: json['lastActivity']?.toString(),
      startedAt: json['startedAt']?.toString(),
      summary: json['summary']?.toString(),
      preview: json['preview']?.toString(),
    );
  }

  String get shortId =>
      chatId.length > 6 ? chatId.substring(chatId.length - 6) : chatId;

  String get lastActivityText {
    if (lastActivity == null) return 'Unknown';
    final dt = DateTime.tryParse(lastActivity!);
    if (dt == null) return lastActivity!;
    final diff = DateTime.now().difference(dt);
    if (diff.inSeconds < 60) return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }
}

enum AttachmentType { image, file, voice }

class ChatAttachment {
  final String name;
  final String path;
  final String? url; // Remote URL for network images (from agent responses)
  final String mimeType;
  final int size;
  final AttachmentType type;

  const ChatAttachment({
    required this.name,
    required this.path,
    this.url,
    required this.mimeType,
    required this.size,
    required this.type,
  });

  /// Whether this attachment has a remote URL (served by gateway).
  bool get isRemote => url != null && url!.isNotEmpty;

  bool get isImage => type == AttachmentType.image;
  bool get isVoice => type == AttachmentType.voice;
  bool get isFile => type == AttachmentType.file;

  /// Create an image attachment from a gateway media response.
  factory ChatAttachment.fromMediaJson(Map<String, dynamic> json) {
    return ChatAttachment(
      name: json['filename']?.toString() ?? 'image',
      path: '', // No local path for remote images
      url: json['url']?.toString() ?? '',
      mimeType: json['mimeType']?.toString() ?? 'image/png',
      size: json['size'] as int? ?? 0,
      type: AttachmentType.image,
    );
  }

  String get sizeLabel {
    if (size < 1024) return '$size B';
    if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(1)} KB';
    return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

class ChatMessage {
  final String id;
  final String content;
  final bool isUser;
  final DateTime timestamp;
  final bool isLoading;
  final bool isError;
  final String? errorDetail;
  final List<ChatAttachment> attachments;
  final MessageStatus status;

  const ChatMessage({
    required this.id,
    required this.content,
    required this.isUser,
    required this.timestamp,
    this.isLoading = false,
    this.isError = false,
    this.errorDetail,
    this.attachments = const [],
    this.status = MessageStatus.sent,
  });

  bool get hasAttachments => attachments.isNotEmpty;
  bool get hasVoiceNote =>
      attachments.any((a) => a.type == AttachmentType.voice);

  ChatMessage copyWith({
    String? content,
    bool? isLoading,
    bool? isError,
    String? errorDetail,
    List<ChatAttachment>? attachments,
    MessageStatus? status,
  }) {
    return ChatMessage(
      id: id,
      content: content ?? this.content,
      isUser: isUser,
      timestamp: timestamp,
      isLoading: isLoading ?? this.isLoading,
      isError: isError ?? this.isError,
      errorDetail: errorDetail ?? this.errorDetail,
      attachments: attachments ?? this.attachments,
      status: status ?? this.status,
    );
  }
}
