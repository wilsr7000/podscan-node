export { PodscanClient, type PodscanClientOptions } from './client.js';
export { PodscanError, type RateLimitInfo } from './http.js';

// Convenience helpers
export { periods } from './periods.js';
export { Paginator } from './paginator.js';

// Resource classes (for advanced usage / mocking)
export { EpisodesResource } from './resources/episodes.js';
export { PodcastsResource } from './resources/podcasts.js';
export { AlertsResource } from './resources/alerts.js';
export { TopicsResource } from './resources/topics.js';
export { EntitiesResource } from './resources/entities.js';
export { ListsResource } from './resources/lists.js';
export { PublishersResource } from './resources/publishers.js';

// All types
export type {
  // Common
  Pagination,
  Quota,
  Sentiment,
  SortDirection,
  SearchHighlight,
  DateRange,
  Checkpoint,

  // Domain objects
  PodcastRef,
  Podcast,
  Episode,
  Category,
  Publisher,
  EpisodeMetadata,
  HostInfo,
  GuestInfo,
  SponsorInfo,
  FirstOccurrence,
  TopicSummary,
  TopicOccurrence,
  TopicMomentum,
  Topic,
  TopicEpisodeOccurrence,
  TrendingTopic,
  Entity,
  EntityAppearanceCounts,
  EntityAppearance,
  Alert,
  Mention,
  ListSummary,
  ListItem,

  // Episodes
  SearchEpisodesParams,
  SearchEpisodesResponse,
  GetEpisodeParams,
  GetEpisodeResponse,
  GetRecentEpisodesParams,
  GetRecentEpisodesResponse,
  GetPodcastEpisodesParams,
  GetPodcastEpisodesResponse,

  // Podcasts
  SearchPodcastsParams,
  SearchPodcastsResponse,
  GetPodcastParams,
  GetPodcastResponse,

  // Entities
  SearchEntitiesParams,
  SearchEntitiesResponse,
  GetEntityParams,
  GetEntityResponse,
  GetEntityAppearancesParams,
  GetEntityAppearancesResponse,

  // Topics
  SearchTopicsParams,
  SearchTopicsResponse,
  GetTopicParams,
  GetTopicResponse,
  GetTopicEpisodesParams,
  GetTopicEpisodesResponse,
  GetTrendingTopicsParams,
  GetTrendingTopicsResponse,

  // Alerts
  ListAlertsParams,
  ListAlertsResponse,
  GetAlertMentionsParams,
  GetAlertMentionsResponse,
  CreateAlertParams,
  CreateAlertResponse,

  // Lists
  ListUserListsParams,
  ListUserListsResponse,
  GetListItemsParams,
  GetListItemsResponse,
  AddToListParams,
  AddToListResponse,

  // Publishers
  GetPublisherParams,
  GetPublisherResponse,
} from './types.js';
