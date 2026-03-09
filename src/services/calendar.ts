import { google, calendar_v3 } from 'googleapis';
import { logger } from '../utils/logger';

export interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  meetLink?: string;
  description?: string;
  recurrence?: string[];
}

export class CalendarService {
  private calendar: calendar_v3.Calendar;
  private calendarId: string;

  constructor() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/oauth2callback';
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Google Calendar credentials are not set');
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  }

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    return this.getEvents(startOfDay, endOfDay);
  }

  async getUpcomingEvents(minutes: number): Promise<CalendarEvent[]> {
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60 * 1000);
    return this.getEvents(now, future);
  }

  async getWeekEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return this.getEvents(now, weekEnd);
  }

  private async getEvents(timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });

      const items = response.data.items ?? [];
      return items.map(item => this.mapEvent(item)).filter((e): e is CalendarEvent => e !== null);
    } catch (err) {
      logger.error({ err }, 'Failed to get calendar events');
      throw err;
    }
  }

  private mapEvent(item: calendar_v3.Schema$Event): CalendarEvent | null {
    if (!item.id || !item.summary) return null;

    const startStr = item.start?.dateTime ?? item.start?.date;
    const endStr = item.end?.dateTime ?? item.end?.date;
    if (!startStr || !endStr) return null;

    const meetLink = item.hangoutLink ??
      item.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri;

    return {
      id: item.id,
      title: item.summary,
      startTime: new Date(startStr),
      endTime: new Date(endStr),
      location: item.location ?? undefined,
      meetLink: meetLink ?? undefined,
      description: item.description ?? undefined,
      recurrence: item.recurrence ?? undefined,
    };
  }

  async createEvent(params: {
    title: string;
    startTime: Date;
    endTime: Date;
    description?: string;
    location?: string;
    recurrence?: string[];
  }): Promise<CalendarEvent> {
    try {
      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: params.title,
          description: params.description,
          location: params.location,
          start: { dateTime: params.startTime.toISOString(), timeZone: process.env.TIMEZONE || 'Europe/Minsk' },
          end: { dateTime: params.endTime.toISOString(), timeZone: process.env.TIMEZONE || 'Europe/Minsk' },
          recurrence: params.recurrence,
        },
      });

      const event = this.mapEvent(response.data);
      if (!event) throw new Error('Failed to map created event');
      logger.info({ eventId: event.id, title: event.title }, 'Calendar event created');
      return event;
    } catch (err) {
      logger.error({ err }, 'Failed to create calendar event');
      throw err;
    }
  }

  async updateEvent(eventId: string, params: {
    title?: string;
    startTime?: Date;
    endTime?: Date;
    description?: string;
  }): Promise<CalendarEvent> {
    try {
      const existing = await this.calendar.events.get({ calendarId: this.calendarId, eventId });
      const body: calendar_v3.Schema$Event = { ...existing.data };

      if (params.title) body.summary = params.title;
      if (params.startTime) body.start = { dateTime: params.startTime.toISOString(), timeZone: process.env.TIMEZONE || 'Europe/Minsk' };
      if (params.endTime) body.end = { dateTime: params.endTime.toISOString(), timeZone: process.env.TIMEZONE || 'Europe/Minsk' };
      if (params.description) body.description = params.description;

      const response = await this.calendar.events.update({ calendarId: this.calendarId, eventId, requestBody: body });
      const event = this.mapEvent(response.data);
      if (!event) throw new Error('Failed to map updated event');
      logger.info({ eventId, title: event.title }, 'Calendar event updated');
      return event;
    } catch (err) {
      logger.error({ err, eventId }, 'Failed to update calendar event');
      throw err;
    }
  }

  getAuthUrl(): string {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/oauth2callback';
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar'],
      prompt: 'consent',
    });
  }

  async getTokensFromCode(code: string): Promise<{ refresh_token: string }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/oauth2callback';
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    return { refresh_token: tokens.refresh_token ?? '' };
  }
}
