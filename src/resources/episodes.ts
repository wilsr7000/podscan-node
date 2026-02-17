import type { HttpClient } from '../http.js';
import type {
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
} from '../types.js';

export class EpisodesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Full-text search across podcast episode transcripts, titles, and descriptions.
   */
  async search(params: SearchEpisodesParams): Promise<SearchEpisodesResponse> {
    return this.http.get<SearchEpisodesResponse>('/episodes/search', params);
  }

  /**
   * Get detailed information about a specific episode.
   */
  async get(params: GetEpisodeParams): Promise<GetEpisodeResponse> {
    const { episode_id, ...query } = params;
    return this.http.get<GetEpisodeResponse>(`/episodes/${episode_id}`, query);
  }

  /**
   * Get the full transcript of an episode.
   */
  async getTranscript(params: GetEpisodeTranscriptParams): Promise<GetEpisodeTranscriptResponse> {
    const { episode_id, ...query } = params;
    return this.http.get<GetEpisodeTranscriptResponse>(`/episodes/${episode_id}/transcript`, query);
  }

  /**
   * Get the most recently published podcast episodes.
   */
  async getRecent(params?: GetRecentEpisodesParams): Promise<GetRecentEpisodesResponse> {
    return this.http.get<GetRecentEpisodesResponse>('/episodes/recent', params);
  }

  /**
   * List all episodes for a specific podcast.
   */
  async getByPodcast(params: GetPodcastEpisodesParams): Promise<GetPodcastEpisodesResponse> {
    const { podcast_id, ...query } = params;
    return this.http.get<GetPodcastEpisodesResponse>(`/podcasts/${podcast_id}/episodes`, query);
  }
}
