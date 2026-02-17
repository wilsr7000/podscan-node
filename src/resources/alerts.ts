import type { HttpClient } from '../http.js';
import type {
  ListAlertsParams,
  ListAlertsResponse,
  GetAlertMentionsParams,
  GetAlertMentionsResponse,
  CreateAlertParams,
  CreateAlertResponse,
} from '../types.js';

export class AlertsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List your team's content monitoring alerts.
   */
  async list(params?: ListAlertsParams): Promise<ListAlertsResponse> {
    return this.http.get<ListAlertsResponse>('/alerts', params);
  }

  /**
   * Get mentions found by a specific alert.
   */
  async getMentions(params: GetAlertMentionsParams): Promise<GetAlertMentionsResponse> {
    const { alert_id, ...query } = params;
    return this.http.get<GetAlertMentionsResponse>(`/alerts/${alert_id}/mentions`, query);
  }

  /**
   * Create a new content monitoring alert.
   */
  async create(params: CreateAlertParams): Promise<CreateAlertResponse> {
    return this.http.post<CreateAlertResponse>('/alerts', params);
  }
}
