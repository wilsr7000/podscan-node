// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface Pagination {
  total: number;
  per_page: number;
  current_page: number;
  last_page: number;
  from: number | null;
  to: number | null;
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

export interface Category {
  category_id: string;
  category_name: string;
}

export interface SearchHighlight {
  transcription?: string;
  description?: string;
  title?: string;
}

// -- Podcasts ---------------------------------------------------------------

export interface PodcastRef {
  podcast_id: string;
  podcast_name: string;
  podcast_url?: string;
  podcast_reach_score?: number;
}

export interface Podcast {
  podcast_id: string;
  podcast_guid: string;
  podcast_name: string;
  podcast_url: string;
  podcast_description: string;
  podcast_image_url: string | null;
  podcast_categories: Category[];
  podcast_iab_categories: string[] | null;
  podcast_has_guests: boolean | null;
  podcast_has_sponsors: boolean | null;
  podcast_itunes_id: string | null;
  podcast_spotify_id: string | null;
  podcast_reach_score: number;
  publisher_name: string | null;
  publisher_ids: string[] | null;
  brand_safety: string | null;
  reach: Record<string, unknown> | null;
  rss_url: string | null;
  is_active: boolean;
  episode_count: number;
  episodes_in_database: number;
  language: string | null;
  region: string | null;
  last_posted_at: string | null;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
  is_duplicate: boolean;
  is_duplicate_of: string | null;
  _search_highlight?: SearchHighlight;
}

// -- Episode metadata (hosts, guests, speakers, summaries) ------------------

export interface HostInfo {
  host_name: string;
  host_company: string | null;
  host_social_media_links: string[] | null;
  speaker_label: string | null;
}

export interface GuestInfo {
  guest_name: string;
  guest_company: string | null;
  guest_social_media_links: string[] | null;
  guest_industry: string | null;
  guest_occupation: string | null;
  speaker_label: string | null;
}

export interface SponsorInfo {
  sponsor_name: string;
  sponsor_url: string | null;
  sponsor_description: string | null;
}

export interface FirstOccurrence {
  type: 'host' | 'guest' | 'keyword' | 'sponsor';
  value: string;
  first_occurence: string;
}

export interface EpisodeMetadata {
  hosts: HostInfo[];
  guests: GuestInfo[];
  sponsors: SponsorInfo[];
  /** Maps speaker labels (e.g. "SPEAKER_01") to real names. */
  speakers: Record<string, string>;
  has_hosts: boolean;
  has_guests: boolean;
  has_sponsors: boolean;
  is_branded: boolean;
  is_branded_confidence_score: number;
  is_branded_confidence_reason: string | null;
  summary_short: string | null;
  summary_long: string | null;
  summary_keywords: string[];
  first_occurences: FirstOccurrence[];
  brand_safety: string | null;
}

// -- Episodes ---------------------------------------------------------------

export interface Episode {
  episode_fully_processed: boolean;
  episode_id: string;
  episode_guid: string;
  episode_title: string;
  episode_url: string;
  episode_audio_url: string | null;
  episode_image_url: string | null;
  episode_duration: number;
  episode_word_count: number;
  episode_categories: Category[];
  episode_iab_category: string | null;
  episode_has_guests: boolean | null;
  episode_has_sponsors: boolean | null;
  created_at: string;
  updated_at: string;
  posted_at: string;
  episode_transcript: string | null;
  episode_transcript_word_level_timestamps: unknown;
  episode_description: string;
  episode_permalink: string;
  podcast: PodcastRef;
  metadata: EpisodeMetadata | null;
  topics: TopicOccurrence[];
  _search_highlight?: SearchHighlight;
}

// -- Topics -----------------------------------------------------------------

export interface TopicSummary {
  topic_id: string;
  name: string;
  occurrences_count?: number;
  latest_occurrence?: string;
}

export interface TopicOccurrence {
  topic_id: string;
  name?: string;
  topic_name?: string;
  topic_name_normalized?: string;
  sentiment?: Sentiment;
}

export interface TopicMomentum {
  daily_growth: number;
  weekly_growth: number;
  is_trending: boolean;
  current_velocity?: {
    occurrences_last_hour: number;
    occurrences_last_day: number;
    occurrences_last_week: number;
  };
}

export interface Topic {
  topic_id: string;
  name: string;
  occurrences_count: number;
  latest_occurrence: string;
  momentum?: TopicMomentum;
  recent_occurrences?: TopicEpisodeOccurrence[];
  related_topics?: TopicSummary[];
  lists?: ListSummary[];
}

export interface TopicEpisodeOccurrence {
  episode_id: string;
  episode_title: string;
  podcast_id: string;
  podcast_name: string;
  posted_at: string;
  sentiment?: Sentiment;
}

export interface TrendingTopic {
  topic_id: string;
  name: string;
  occurrences: number;
  momentum?: TopicMomentum;
  related_topics?: TopicSummary[];
}

// -- Entities ---------------------------------------------------------------

export interface EntityAppearanceCounts {
  hosts_count: number;
  guests_count: number;
  sponsors_count: number;
  producers_count: number;
  mentions_count: number;
  total_count: number;
}

export interface Entity {
  entity_id: string;
  entity_name: string;
  entity_type: 'person' | 'organization';
  created_at: string;
  updated_at: string;
  company: string | null;
  occupation: string | null;
  industry: string | null;
  url: string | null;
  appearances: EntityAppearanceCounts;
  _search_highlight?: SearchHighlight;
}

export interface EntityAppearance {
  appearance_id?: string;
  role: string;
  episode_id: string;
  episode_title: string;
  podcast_id: string;
  podcast_name: string;
  posted_at: string;
}

// -- Alerts -----------------------------------------------------------------

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

// -- Lists ------------------------------------------------------------------

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

// -- Publishers -------------------------------------------------------------

export interface Publisher {
  publisher_id: string;
  publisher_name: string;
  website?: string;
  podcasts?: Podcast[];
}

// ---------------------------------------------------------------------------
// Request params
// ---------------------------------------------------------------------------

// -- Episodes ---------------------------------------------------------------

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

export interface GetEpisodeParams {
  episode_id: string;
  include_transcript?: boolean;
  include_topics?: boolean;
  include_entities?: boolean;
}

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

// -- Podcasts ---------------------------------------------------------------

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

export interface GetPodcastParams {
  podcast_id: string;
  include_episodes?: boolean;
  episode_limit?: number;
  include_demographics?: boolean;
  include_reviews?: boolean;
}

// -- Entities ---------------------------------------------------------------

export interface SearchEntitiesParams {
  query: string;
  entity_type?: 'person' | 'organization';
  min_appearances?: number;
  order_by?: 'appearances' | 'name';
  order_dir?: SortDirection;
  page?: number;
  per_page?: number;
}

export interface GetEntityParams {
  entity_id: string;
  with_appearances?: boolean;
  appearances_limit?: number;
}

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

// -- Topics -----------------------------------------------------------------

export interface SearchTopicsParams {
  query: string;
  min_episodes?: number;
  order_by?: 'relevance' | 'episode_count';
  order_dir?: SortDirection;
  page?: number;
  per_page?: number;
}

export interface GetTopicParams {
  topic_id: string;
  with_history?: boolean;
}

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

export interface GetTrendingTopicsParams {
  period?: '24h' | '7d' | '30d';
  limit?: number;
  category?: string;
}

// -- Alerts -----------------------------------------------------------------

export interface ListAlertsParams {
  enabled_only?: boolean;
  page?: number;
  per_page?: number;
}

export interface GetAlertMentionsParams {
  alert_id: string;
  since?: string;
  detected_type?: 'transcript' | 'title' | 'description';
  page?: number;
  per_page?: number;
}

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

// -- Lists ------------------------------------------------------------------

export interface ListUserListsParams {
  page?: number;
  per_page?: number;
}

export interface GetListItemsParams {
  list_id: string;
  item_type?: 'podcasts' | 'episodes' | 'entities' | 'topics';
  page?: number;
  per_page?: number;
}

export interface AddToListParams {
  list_id: string;
  item_ids: string;
}

// -- Publishers -------------------------------------------------------------

export interface GetPublisherParams {
  publisher_id: string;
  include_podcasts?: boolean;
  podcast_limit?: number;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

// -- Episodes ---------------------------------------------------------------

export interface SearchEpisodesResponse {
  episodes: Episode[];
  pagination: Pagination;
}

export interface GetEpisodeResponse {
  episode: Episode;
}

export interface GetRecentEpisodesResponse {
  episodes: Episode[];
}

export interface GetPodcastEpisodesResponse {
  episodes: Episode[];
  pagination: Pagination;
}

// -- Podcasts ---------------------------------------------------------------

export interface SearchPodcastsResponse {
  podcasts: Podcast[];
  pagination: Pagination;
}

export interface GetPodcastResponse {
  podcast: Podcast;
}

// -- Entities ---------------------------------------------------------------

export interface SearchEntitiesResponse {
  entities: Entity[];
  pagination: Pagination;
  filters?: Record<string, unknown>;
}

export interface GetEntityResponse {
  entity: Entity;
}

export interface GetEntityAppearancesResponse {
  entity: Entity;
  appearances: EntityAppearance[];
  pagination: Pagination;
}

// -- Topics -----------------------------------------------------------------

export interface SearchTopicsResponse {
  topics: TopicSummary[];
  pagination: Pagination;
}

export interface GetTopicResponse {
  topic: Topic;
}

export interface GetTopicEpisodesResponse {
  episodes: Episode[];
  pagination: Pagination;
}

export interface GetTrendingTopicsResponse {
  topics: TrendingTopic[];
  timeframe?: string;
}

// -- Alerts -----------------------------------------------------------------

export interface ListAlertsResponse {
  alerts: Alert[];
  pagination: Pagination;
}

export interface GetAlertMentionsResponse {
  mentions: Mention[];
  pagination: Pagination;
}

export interface CreateAlertResponse {
  alert: Alert;
}

// -- Lists ------------------------------------------------------------------

export interface ListUserListsResponse {
  lists: ListSummary[];
  pagination: Pagination;
}

export interface GetListItemsResponse {
  items: ListItem[];
  pagination: Pagination;
}

export interface AddToListResponse {
  success: boolean;
  summary: { added: number; skipped: number; failed: number };
  added: string[];
  skipped: string[];
  failed: { id: string; reason: string }[];
}

// -- Publishers -------------------------------------------------------------

export interface GetPublisherResponse {
  publisher: Publisher;
}

// ---------------------------------------------------------------------------
// Time period helpers
// ---------------------------------------------------------------------------

/** A date range that can be spread into any search params with `since`/`before`. */
export interface DateRange {
  since: string;
  before?: string;
}

// ---------------------------------------------------------------------------
// Pagination / sync helpers
// ---------------------------------------------------------------------------

/** Checkpoint for delta/incremental sync workflows. */
export interface Checkpoint {
  /** ISO 8601 timestamp of the most recent item seen. */
  lastSeenAt: string;
  /** ID of the most recent item seen. */
  lastSeenId: string;
  /** Total number of items iterated. */
  totalSeen: number;
}
