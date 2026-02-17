import type { HttpClient } from '../http.js';
import type { GetPublisherParams, GetPublisherResponse } from '../types.js';

export class PublishersResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Get publisher information with their podcast portfolio.
   */
  async get(params: GetPublisherParams): Promise<GetPublisherResponse> {
    const { publisher_id, ...query } = params;
    return this.http.get<GetPublisherResponse>(`/publishers/${publisher_id}`, query);
  }
}
