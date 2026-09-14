import { Injectable, Logger } from '@nestjs/common';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const BLOCKED_HOSTS =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class ToolsService {
  private log = new Logger('Tools');

  // duckduckgo html endpoint, no api key needed
  async webSearch(query: string): Promise<SearchResult[]> {
    const res = await fetch(
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
      {
        headers: {
          'user-agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        },
        signal: AbortSignal.timeout(12000),
      },
    );
    const html = await res.text();
    const results: SearchResult[] = [];
    const linkRe =
      /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g;
    const links: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && links.length < 6) {
      let url = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      links.push({ url, title: stripTags(m[2]) });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) && snippets.length < 6) {
      snippets.push(stripTags(m[1]));
    }
    links.forEach((l, i) =>
      results.push({ ...l, snippet: snippets[i] ?? '' }),
    );
    this.log.log(`web_search "${query}" -> ${results.length} results`);
    return results.slice(0, 5);
  }

  // search, then read the best result too — snippets alone rarely hold the answer
  async webSearchDeep(query: string) {
    const results = await this.webSearch(query);
    let topContent = '';
    if (results[0]) {
      topContent = (await this.webFetch(results[0].url)).slice(0, 3000);
    }
    return { results, top_result_content: topContent };
  }

  // live scores straight from espn's public scoreboard feed
  async getScores(league: string, team?: string): Promise<string> {
    const paths: Record<string, string> = {
      nfl: 'football/nfl',
      nba: 'basketball/nba',
      mlb: 'baseball/mlb',
      nhl: 'hockey/nhl',
      ncaaf: 'football/college-football',
      ncaab: 'basketball/mens-college-basketball',
      mls: 'soccer/usa.1',
    };
    const path = paths[league.toLowerCase()];
    if (!path) return `Unknown league "${league}". I know: ${Object.keys(paths).join(', ')}`;
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`,
        { signal: AbortSignal.timeout(12000) },
      );
      const d: any = await res.json();
      let games = (d.events ?? []).map((e: any) => {
        const comp = e.competitions?.[0];
        const teams = (comp?.competitors ?? []).map((c: any) => ({
          team: c.team?.displayName,
          score: c.score,
          record: c.records?.[0]?.summary,
          winner: c.winner ?? undefined,
        }));
        return {
          matchup: e.name,
          date: e.date,
          status: comp?.status?.type?.detail ?? e.status?.type?.detail,
          teams,
        };
      });
      if (team) {
        const t = team.toLowerCase();
        const filtered = games.filter((g: any) =>
          g.matchup?.toLowerCase().includes(t),
        );
        if (filtered.length) games = filtered;
      }
      if (!games.length) return 'No games on the scoreboard right now.';
      this.log.log(`get_scores ${league} ${team ?? ''} -> ${games.length} games`);
      return JSON.stringify(games.slice(0, 8));
    } catch (e: any) {
      return `Score lookup failed: ${e.message}`;
    }
  }

  async getWeather(location: string): Promise<string> {
    try {
      const res = await fetch(
        `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
        { signal: AbortSignal.timeout(12000) },
      );
      const d: any = await res.json();
      const c = d.current_condition?.[0];
      if (!c) return 'No weather data found for that location.';
      const area = d.nearest_area?.[0];
      const place = area
        ? `${area.areaName?.[0]?.value}, ${area.region?.[0]?.value}`
        : location;
      const days = (d.weather ?? []).slice(0, 3).map((w: any) => ({
        date: w.date,
        highF: w.maxtempF,
        lowF: w.mintempF,
        description: w.hourly?.[4]?.weatherDesc?.[0]?.value,
        chanceOfRain: w.hourly?.[4]?.chanceofrain + '%',
      }));
      this.log.log(`get_weather ${place}`);
      return JSON.stringify({
        location: place,
        now: {
          tempF: c.temp_F,
          feelsLikeF: c.FeelsLikeF,
          condition: c.weatherDesc?.[0]?.value,
          humidity: c.humidity + '%',
          windMph: c.windspeedMiles,
        },
        forecast: days,
      });
    } catch (e: any) {
      return `Weather lookup failed: ${e.message}`;
    }
  }

  // pull a page down as plain text; refuses anything pointing at our own lan
  async webFetch(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Invalid URL.';
    }
    if (!/^https?:$/.test(parsed.protocol) || BLOCKED_HOSTS.test(parsed.hostname)) {
      return 'This URL is not allowed.';
    }
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('html') && !type.includes('text') && !type.includes('json')) {
        return `Not a readable page (content-type ${type}).`;
      }
      const body = await res.text();
      const text = type.includes('json') ? body : stripTags(body);
      this.log.log(`web_fetch ${parsed.hostname} -> ${text.length} chars`);
      return text.slice(0, 6000);
    } catch (e: any) {
      return `Could not fetch the page: ${e.message}`;
    }
  }
}

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a lasting fact to your permanent memory so you know it in every future chat. Use it whenever someone tells you something worth keeping: their preferences, birthdays, nicknames, family facts, or a name they give you. Do NOT use it for throwaway conversation details.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'The fact, written so it makes sense on its own later, e.g. "The family named me Sparky" or "Sam\'s favorite team is the Bills"',
          },
          scope: {
            type: 'string',
            enum: ['user', 'family'],
            description:
              '"user" for facts about the person you are talking to; "family" for facts about the whole family or about yourself',
          },
        },
        required: ['content', 'scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Create a brand-new image from a text description. Use whenever someone asks you to draw, paint, create, generate, or make a picture of something. Write a vivid, detailed prompt in English.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Detailed visual description: subject, setting, style, lighting, mood',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sports_scores',
      description:
        'Get live and recent game scores. ALWAYS use this for any sports score question instead of web_search. Leagues: nfl, nba, mlb, nhl, ncaaf, ncaab, mls.',
      parameters: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['nfl', 'nba', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'mls'],
          },
          team: {
            type: 'string',
            description: 'Optional team name to filter to, e.g. "Giants"',
          },
        },
        required: ['league'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        'Get the current weather and 3-day forecast for a location. ALWAYS use this for any weather question instead of web_search.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City and state/country, e.g. "Webster, NY"',
          },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information, news, facts, prices, weather, sports scores — anything you do not reliably know or that may have changed recently.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch and read the text of one web page, e.g. a promising result from web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full http(s) URL to read' },
        },
        required: ['url'],
      },
    },
  },
];
