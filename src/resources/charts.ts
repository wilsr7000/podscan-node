import type { HttpClient } from '../http.js';
import type { GetChartsParams, GetChartsResponse } from '../types.js';

export class ChartsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get podcast chart rankings from Apple Podcasts and Spotify.
   */
  async get(params: GetChartsParams): Promise<GetChartsResponse> {
    return this.http.get<GetChartsResponse>('/charts', params);
  }
}
