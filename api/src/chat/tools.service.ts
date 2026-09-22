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
    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
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
    links.forEach((l, i) => results.push({ ...l, snippet: snippets[i] ?? '' }));
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
    if (!path)
      return `Unknown league "${league}". I know: ${Object.keys(paths).join(', ')}`;
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
      this.log.log(
        `get_scores ${league} ${team ?? ''} -> ${games.length} games`,
      );
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
    if (
      !/^https?:$/.test(parsed.protocol) ||
      BLOCKED_HOSTS.test(parsed.hostname)
    ) {
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
      if (
        !type.includes('html') &&
        !type.includes('text') &&
        !type.includes('json')
      ) {
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
      name: 'add_event',
      description:
        'Add something to the shared family calendar: practices, appointments, parties, birthdays, school events, trips. Use it whenever someone mentions a plan with a date. Pass the date and time EXACTLY as the person said it in "when" — the server works out the real date.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title, e.g. "Soccer game" or "Dentist"',
          },
          when: {
            type: 'string',
            description:
              'The date/time in the person\'s own words, e.g. "Saturday at 10am", "next Tuesday 3:30pm", "tomorrow", "June 7 at 2pm", "Oct 3" (all day)',
          },
          location: { type: 'string' },
          who: {
            type: 'string',
            description: 'Who it is for, e.g. a child\'s name or "everyone"',
          },
          notes: { type: 'string' },
        },
        required: ['title', 'when'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_events',
      description:
        'Look at the family calendar. Use for questions like "what\'s this weekend", "when is the dentist", "what does the youngest have this week". Dates are local YYYY-MM-DD; defaults to the next 30 days.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_event',
      description:
        'Remove an event from the family calendar. Get the id from list_events first and confirm with the user which one.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_something_to_watch',
      description:
        'Use this the moment someone wants to WATCH something now — "I want to watch Harry Potter", "put on Encanto", "can we watch a movie". It looks through what the family already owns and shows them the matches to tap, then they pick a TV. Do NOT use search_movies for this; that one is for adding things they do not have.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The title they said, e.g. "harry potter"',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tvs',
      description:
        'List the TVs in the house that something can be played on right now. Use when someone asks what TVs there are, or before playing if they have not said which one.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_on_tv',
      description:
        'Start something playing on a TV. Only use ids that came back from find_something_to_watch in this conversation, and a TV name from list_tvs.',
      parameters: {
        type: 'object',
        properties: {
          itemId: {
            type: 'string',
            description: 'id from find_something_to_watch',
          },
          tv: {
            type: 'string',
            description: 'the TV name, e.g. "living room"',
          },
        },
        required: ['itemId', 'tv'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_tv',
      description: 'Stop whatever is playing on a TV.',
      parameters: {
        type: 'object',
        properties: { tv: { type: 'string' } },
        required: ['tv'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description:
        'Look up films by name when someone wants one added to the family library ("add Harry Potter", "can we get Interstellar"). Shows the family a list to pick from, so call this FIRST and let them choose — do not guess which one they meant.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The title they said, e.g. "harry potter"',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_movies',
      description:
        'Add specific films to the library list. Only use ids that came back from search_movies in this conversation — for example when they follow up with "just the first three" or "all of them".',
      parameters: {
        type: 'object',
        properties: {
          movieIds: {
            type: 'array',
            items: { type: 'number' },
            description: 'catalogId values from search_movies',
          },
        },
        required: ['movieIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_series',
      description:
        'Look up TV shows by name when someone wants one added ("add The Office", "get Fallout"). Shows the family the matches to choose from.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The show name they said' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_series_seasons',
      description:
        'List the seasons of a show, with how many of its episodes are already in the library. Use after search_series when they mention seasons.',
      parameters: {
        type: 'object',
        properties: {
          seriesId: {
            type: 'number',
            description: 'catalogId from search_series',
          },
        },
        required: ['seriesId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_season_episodes',
      description:
        'List the episodes in one season of a show, with what is already in the library.',
      parameters: {
        type: 'object',
        properties: {
          seriesId: { type: 'number' },
          seasonNumber: { type: 'number' },
        },
        required: ['seriesId', 'seasonNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_series',
      description:
        'Add a show to the library list. Leave seasons empty for the whole show, or pass the season numbers they asked for ("seasons two and three").',
      parameters: {
        type: 'object',
        properties: {
          seriesId: {
            type: 'number',
            description: 'catalogId from search_series',
          },
          seasons: {
            type: 'array',
            items: { type: 'number' },
            description:
              'Season numbers; omit or leave empty for the whole show',
          },
        },
        required: ['seriesId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_episodes',
      description:
        'Add individual episodes of a show to the library list, e.g. "season 3 episode 7".',
      parameters: {
        type: 'object',
        properties: {
          seriesId: { type: 'number' },
          episodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                season: { type: 'number' },
                episode: { type: 'number' },
              },
              required: ['season', 'episode'],
            },
          },
        },
        required: ['seriesId', 'episodes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_media_request_status',
      description:
        'Check what is on the family library list and how far along each thing is ("is Harry Potter ready yet", "what did we ask for").',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional title to filter by; omit for everything',
          },
        },
      },
    },
  },
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
