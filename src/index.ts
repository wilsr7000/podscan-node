export { PodscanClient, type PodscanClientOptions } from './client.js';
export { PodscanError, type RateLimitInfo } from './http.js';

// Resource classes (for advanced usage / mocking)
export { EpisodesResource } from './resources/episodes.js';
export { PodcastsResource } from './resources/podcasts.js';
export { AlertsResource } from './resources/alerts.js';
export { TopicsResource } from './resources/topics.js';
export { EntitiesResource } from './resources/entities.js';
export { ListsResource } from './resources/lists.js';
export { ChartsResource } from './resources/charts.js';
export { PublishersResource } from './resources/publishers.js';

// All types
export type {
  // Common
  Pagination,
  Quota,
  Sentiment,
  SortDirection,

  // Domain objects
  PodcastSummary,
  Podcast,
  Episode,
  Category,
  PublisherSummary,
  Publisher,
  TopicSummary,
  TopicOccurrence,
  Topic,
  TopicHistory,
  TopicEpisodeOccurrence,
  EntitySummary,
  Entity,
  AppearanceCounts,
  EntityAppearance,
  Alert,
  Mention,
  ListSummary,
  ListItem,
  ChartEntry,
  ReviewSummary,
  Demographics,
  TrendingTopic,

  // Episodes
  SearchEpisodesParams,
  SearchEpisodesResponse,
  GetEpisodeParams,
  GetEpisodeResponse,
  GetEpisodeTranscriptParams,
  GetEpisodeTranscriptResponse,
  GetRecentEpisodesParams,
  GetRecentEpisodesResponse,
  GetPodcastEpisodesParams,
  GetPodcastEpisodesResponse,

  // Podcasts
  SearchPodcastsParams,
  SearchPodcastsResponse,
  GetPodcastParams,
  GetPodcastResponse,
  GetSimilarPodcastsParams,
  GetSimilarPodcastsResponse,
  GetPodcastReviewsParams,
  GetPodcastReviewsResponse,
  GetPodcastDemographicsParams,
  GetPodcastDemographicsResponse,

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

  // Charts
  GetChartsParams,
  GetChartsResponse,

  // Publishers
  GetPublisherParams,
  GetPublisherResponse,
} from './types.js';
