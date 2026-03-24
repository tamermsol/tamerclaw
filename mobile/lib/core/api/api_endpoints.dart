abstract final class ApiEndpoints {
  static const String login = '/api/auth/login';
  static const String agents = '/api/agents';
  static String agentMessage(String agentId) => '/api/agents/$agentId/message';
  static const String status = '/api/status';
  static const String health = '/api/health';
  static const String cronJobs = '/api/cron/jobs';
  static String cronJob(String id) => '/api/cron/jobs/$id';
  static const String deliveryQueue = '/api/delivery-queue';

  // Agent detail
  static String agentDetail(String id) => '/api/agents/$id';
  static const String createAgent = '/api/agents';
  static String updateAgent(String id) => '/api/agents/$id';
  static String deleteAgent(String id) => '/api/agents/$id';
  static const String config = '/api/config';

  // Session endpoints
  static String agentSessions(String agentId) => '/api/agents/$agentId/sessions';
  static String sessionHistory(String agentId, String chatId) =>
      '/api/agents/$agentId/sessions/$chatId';
  static String deleteSession(String agentId, String chatId) =>
      '/api/agents/$agentId/sessions/$chatId';

  // Agent activity status
  static String agentActivity(String agentId) => '/api/agents/$agentId/activity';

  // Stop agent (kill active Claude process)
  static String stopAgent(String agentId) => '/api/agents/$agentId/stop';

  // Polling endpoint for 2-way communication
  static String pollMessages(String agentId, {String? chatId, String? since}) {
    final params = <String>[];
    if (chatId != null) params.add('chatId=$chatId');
    if (since != null) params.add('since=$since');
    final query = params.isNotEmpty ? '?${params.join('&')}' : '';
    return '/api/agents/$agentId/poll$query';
  }
}
