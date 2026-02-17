// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  has_more: boolean;
}

export interface Quota {
  daily_used: number;
  daily_limit: number;
  daily_remaining: number;
  plan: string;
  resets_at: string;
}

export interface Sentiment {
  label: string;
  short: string;
  score: number;
}

export type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Core domain objects
// ---------------------------------------------------------------------------

export interface PodcastSummary {
  podcast_id: string;
  podcast_name: string;
  description?: string;
  website?: string;
  rss_feed?: string;
  language?: string;
  categories?: Category[];
  audience_size_estimate?: number;
  itunes_rating?: number;
  spotify_rating?: number;
  episode_count?: number;
  last_posted_at?: string;
}

export interface Podcast extends PodcastSummary {
  authors?: string;
  publisher?: PublisherSummary;
  demographics?: Demographics;
  recent_episodes?: Episode[];
  reviews?: ReviewSummary;
}

export interface Episode {
  episode_id: string;
  episode_title: string;
  posted_at: string;
  duration: number;
  summary?: string;
  podcast?: PodcastSummary;
  transcript?: string;
  hosts?: EntitySummary[];
  guests?: EntitySummary[];
  sponsors?: EntitySummary[];
  topics?: TopicOccurrence[];
  _search_highlight?: string;
}

export interface Category {
  category_id: string;
  category_name: string;
}

export interface PublisherSummary {
  publisher_id: string;
  publisher_name: string;
}

export interface Publisher extends PublisherSummary {
  website?: string;
  podcasts?: PodcastSummary[];
}

export interface TopicSummary {
  topic_id: string;
  topic_name: string;
}

export interface TopicOccurrence extends TopicSummary {
  topic_name_normalized?: string;
  sentiment?: Sentiment;
}

export interface Topic extends TopicSummary {
  topic_name_normalized: string;
  occurrences_count: number;
  latest_occurrence: string;
  momentum?: Record<string, unknown>;
  recent_occurrences?: TopicEpisodeOccurrence[];
  related_topics?: TopicSummary[];
  lists?: ListSummary[];
  history?: TopicHistory[];
}

export interface TopicHistory {
  date: string;
  count: number;
}

export interface TopicEpisodeOccurrence {
  episode_id: string;
  episode_title: string;
  podcast_id: string;
  podcast_name: string;
  posted_at: string;
  sentiment?: Sentiment;
}

export interface EntitySummary {
  entity_id: string;
  entity_name: string;
  entity_type: 'person' | 'organization';
}

export interface Entity extends EntitySummary {
  url?: string;
  company?: string;
  occupation?: string;
  industry?: string;
  social_links?: Record<string, string>;
  total_appearances: number;
  appearance_counts: AppearanceCounts;
  recent_appearances?: EntityAppearance[];
}

export interface AppearanceCounts {
  host?: number;
  guest?: number;
  sponsor?: number;
  producer?: number;
  mention?: number;
}

export interface EntityAppearance {
  appearance_id: string;
  role: string;
  episode_id: string;
  episode_title: string;
  podcast_id: string;
  podcast_name: string;
  posted_at: string;
}

export interface Alert {
  alert_id: string;
  alert_name: string;
  filters: string;
  enabled: boolean;
  mention_count: number;
  recent_mention_count: number;
  created_at: string;
}

export interface Mention {
  mention_id: string;
  detected_filter: string;
  detected_excerpt: string;
  detected_at: string;
  sentiment?: Sentiment;
  episode?: Episode;
}

export interface ListSummary {
  list_id: string;
  list_name: string;
  list_description?: string;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface ListItem {
  id: string;
  type: 'podcast' | 'episode' | 'entity' | 'topic';
  [key: string]: unknown;
}

export interface ChartEntry {
  position: number;
  previous_position?: number;
  position_change?: number;
  weeks_on_chart?: number;
  podcast_id: string;
  podcast_name: string;
}

export interface ReviewSummary {
  podcast_id: string;
  podcast_name: string;
  itunes_rating_average?: number;
  itunes_rating_count?: number;
  spotify_rating_average?: number;
  spotify_rating_count?: number;
  combined_rating?: number;
  rating_trend?: string;
}

export interface Demographics {
  language?: string;
  region?: string;
  audience_size_estimate?: number;
  [key: string]: unknown;
}

export interface TrendingTopic extends TopicSummary {
  mention_count: number;
  growth_rate: number;
  top_episodes?: Episode[];
}

// ---------------------------------------------------------------------------
// Paginated / list response wrappers
// ---------------------------------------------------------------------------

export interface PaginatedResponse {
  pagination: Pagination;
  quota?: Quota;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Search Episodes
// ---------------------------------------------------------------------------

export interface SearchEpisodesParams {
  query: string;
  search_fields?: string;
  category_ids?: string;
  podcast_ids?: string;
  since?: string;
  before?: string;
  language?: string;
  has_guests?: boolean;
  has_sponsors?: boolean;
  show_only_fully_processed?: boolean;
  order_by?: 'posted_at' | 'relevance' | 'duration';
  order_dir?: SortDirection;
  page?: number;
  per_page?: number;
  exclude_transcript?: boolean;
  show_full_podcast?: boolean;
  remove_timestamps?: boolean;
  remove_speaker_labels?: boolean;
  transcript_formatter?: 'raw' | 'paragraphs';
}

export interface SearchEpisodesResponse {
  episodes: Episode[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Episode
// ---------------------------------------------------------------------------

export interface GetEpisodeParams {
  episode_id: string;
  include_transcript?: boolean;
  include_topics?: boolean;
  include_entities?: boolean;
}

export interface GetEpisodeResponse {
  episode: Episode;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Episode Transcript
// ---------------------------------------------------------------------------

export interface GetEpisodeTranscriptParams {
  episode_id: string;
  format?: 'plain' | 'timestamped';
  search?: string;
}

export interface GetEpisodeTranscriptResponse {
  episode_id: string;
  episode_title: string;
  transcript: string;
  word_count: number;
  duration: number;
  matches?: string[];
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Recent Episodes
// ---------------------------------------------------------------------------

export interface GetRecentEpisodesParams {
  limit?: number;
  since?: string;
  before?: string;
  category_ids?: string;
  podcast_ids?: string;
  language?: string;
  has_guests?: boolean;
  has_sponsors?: boolean;
  show_only_fully_processed?: boolean;
  exclude_transcript?: boolean;
  show_full_podcast?: boolean;
  remove_timestamps?: boolean;
  remove_speaker_labels?: boolean;
  transcript_formatter?: 'raw' | 'paragraphs';
}

export interface GetRecentEpisodesResponse {
  episodes: Episode[];
  count: number;
  filters?: Record<string, unknown>;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Podcast Episodes
// ---------------------------------------------------------------------------

export interface GetPodcastEpisodesParams {
  podcast_id: string;
  per_page?: number;
  page?: number;
  order_by?: 'posted_at' | 'created_at' | 'title' | 'duration';
  order_dir?: SortDirection;
  since?: string;
  before?: string;
  has_guests?: boolean;
  has_sponsors?: boolean;
  title_contains?: string;
  title_excludes?: string;
  exclude_transcript?: boolean;
  show_full_podcast?: boolean;
  remove_timestamps?: boolean;
  remove_speaker_labels?: boolean;
  transcript_formatter?: 'raw' | 'paragraphs';
}

export interface GetPodcastEpisodesResponse {
  podcast_id: string;
  podcast_name: string;
  episodes: Episode[];
  pagination: Pagination;
  sort?: { field: string; direction: SortDirection };
  filters?: Record<string, unknown>;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Search Podcasts
// ---------------------------------------------------------------------------

export interface SearchPodcastsParams {
  query: string;
  search_fields?: string;
  category_ids?: string;
  language?: string;
  region?: string;
  min_audience_size?: number;
  max_audience_size?: number;
  min_episode_count?: number;
  has_guests?: boolean;
  has_sponsors?: boolean;
  order_by?: 'rating' | 'audience_size' | 'episode_count';
  order_dir?: SortDirection;
  page?: number;
  per_page?: number;
}

export interface SearchPodcastsResponse {
  podcasts: PodcastSummary[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Podcast
// ---------------------------------------------------------------------------

export interface GetPodcastParams {
  podcast_id: string;
  include_episodes?: boolean;
  episode_limit?: number;
  include_demographics?: boolean;
  include_reviews?: boolean;
}

export interface GetPodcastResponse {
  podcast: Podcast;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Similar Podcasts
// ---------------------------------------------------------------------------

export interface GetSimilarPodcastsParams {
  podcast_id: string;
  limit?: number;
}

export interface GetSimilarPodcastsResponse {
  podcast_id: string;
  podcasts: PodcastSummary[];
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Podcast Reviews
// ---------------------------------------------------------------------------

export interface GetPodcastReviewsParams {
  podcast_id: string;
}

export interface GetPodcastReviewsResponse {
  reviews: ReviewSummary;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Podcast Demographics
// ---------------------------------------------------------------------------

export interface GetPodcastDemographicsParams {
  language?: string;
  region?: string;
  category_ids?: string;
  min_audience_size?: number;
  max_audience_size?: number;
  order_by?: string;
  page?: number;
  per_page?: number;
}

export interface GetPodcastDemographicsResponse {
  podcasts: PodcastSummary[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Search People & Brands
// ---------------------------------------------------------------------------

export interface SearchEntitiesParams {
  query: string;
  entity_type?: 'person' | 'organization';
  min_appearances?: number;
  order_by?: 'appearances' | 'name';
  order_dir?: SortDirection;
  page?: number;
  per_page?: number;
}

export interface SearchEntitiesResponse {
  entities: EntitySummary[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Entity
// ---------------------------------------------------------------------------

export interface GetEntityParams {
  entity_id: string;
  with_appearances?: boolean;
  appearances_limit?: number;
}

export interface GetEntityResponse {
  entity: Entity;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Entity Appearances
// ---------------------------------------------------------------------------

export interface GetEntityAppearancesParams {
  entity_id: string;
  per_page?: number;
  page?: number;
  role?: 'host' | 'guest' | 'sponsor' | 'producer' | 'mention';
  podcast_id?: string;
  from?: string;
  to?: string;
  order_by?: 'posted_at' | 'created_at';
  order_dir?: SortDirection;
}

export interface GetEntityAppearancesResponse {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  total_appearances: number;
  appearances: EntityAppearance[];
  pagination: Pagination;
  sort?: { field: string; direction: SortDirection };
  filters?: Record<string, unknown>;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Search Topics
// ---------------------------------------------------------------------------

export interface SearchTopicsParams {
  query: string;
  min_episodes?: number;
  order_by?: 'relevance' | 'episode_count';
  order_dir?: SortDirection;
  page?: number;
  per_page?: number;
}

export interface SearchTopicsResponse {
  topics: TopicSummary[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Topic
// ---------------------------------------------------------------------------

export interface GetTopicParams {
  topic_id: string;
  with_history?: boolean;
}

export interface GetTopicResponse {
  topic: Topic;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Topic Episodes
// ---------------------------------------------------------------------------

export interface GetTopicEpisodesParams {
  topic_id: string;
  per_page?: number;
  page?: number;
  podcast_has_guests?: boolean;
  podcast_has_sponsors?: boolean;
  podcast_audience_min?: number;
  podcast_audience_max?: number;
  exclude_transcript?: boolean;
  show_full_podcast?: boolean;
  remove_timestamps?: boolean;
  remove_speaker_labels?: boolean;
  transcript_formatter?: 'raw' | 'paragraphs';
}

export interface GetTopicEpisodesResponse {
  topic_id: string;
  topic_name: string;
  episodes: Episode[];
  pagination: Pagination;
  filters?: Record<string, unknown>;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Trending Topics
// ---------------------------------------------------------------------------

export interface GetTrendingTopicsParams {
  period?: '24h' | '7d' | '30d';
  limit?: number;
  category?: string;
}

export interface GetTrendingTopicsResponse {
  topics: TrendingTopic[];
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// List Alerts
// ---------------------------------------------------------------------------

export interface ListAlertsParams {
  enabled_only?: boolean;
  page?: number;
  per_page?: number;
}

export interface ListAlertsResponse {
  alerts: Alert[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Alert Mentions
// ---------------------------------------------------------------------------

export interface GetAlertMentionsParams {
  alert_id: string;
  since?: string;
  detected_type?: 'transcript' | 'title' | 'description';
  page?: number;
  per_page?: number;
}

export interface GetAlertMentionsResponse {
  mentions: Mention[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Create Alert
// ---------------------------------------------------------------------------

export interface CreateAlertParams {
  name: string;
  filters: string;
  context_question?: string;
  use_context_question?: boolean;
  notification_email?: string;
  webhook_url?: string;
  webhook_active?: boolean;
  enabled?: boolean;
}

export interface CreateAlertResponse {
  alert: Alert;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// List User Lists
// ---------------------------------------------------------------------------

export interface ListUserListsParams {
  page?: number;
  per_page?: number;
}

export interface ListUserListsResponse {
  lists: ListSummary[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get List Items
// ---------------------------------------------------------------------------

export interface GetListItemsParams {
  list_id: string;
  item_type?: 'podcasts' | 'episodes' | 'entities' | 'topics';
  page?: number;
  per_page?: number;
}

export interface GetListItemsResponse {
  items: ListItem[];
  pagination: Pagination;
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Add to List
// ---------------------------------------------------------------------------

export interface AddToListParams {
  list_id: string;
  item_ids: string;
}

export interface AddToListResponse {
  success: boolean;
  summary: { added: number; skipped: number; failed: number };
  added: string[];
  skipped: string[];
  failed: { id: string; reason: string }[];
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Charts
// ---------------------------------------------------------------------------

export interface GetChartsParams {
  platform: 'apple' | 'spotify';
  chart_type?: 'top' | 'new' | 'trending';
  category?: string;
  country?: string;
  limit?: number;
}

export interface GetChartsResponse {
  charts: ChartEntry[];
  quota?: Quota;
}

// ---------------------------------------------------------------------------
// Get Publisher
// ---------------------------------------------------------------------------

export interface GetPublisherParams {
  publisher_id: string;
  include_podcasts?: boolean;
  podcast_limit?: number;
}

export interface GetPublisherResponse {
  publisher: Publisher;
  quota?: Quota;
}
