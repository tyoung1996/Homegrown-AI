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
        'THE LIBRARY — what this family actually owns and can play tonight. ' +
        'Use this the moment someone wants to watch something: "I want to ' +
        'watch Harry Potter", "put on Encanto", "play The Office S03E12". It ' +
        'looks on the shelf first and tells you whether it is there. If it is ' +
        'not, it comes back with what the film or show actually is, so you ' +
        'can offer to add it — but do NOT add anything unless they say yes. ' +
        'To continue a show, play its next episode, start it over or play a ' +
        'named episode of a show we have, use play_show instead.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'What they said, including any season and episode: "harry ' +
              'potter", "the office s3e12", "the office season 3"',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend',
      description:
        'Suggest something to watch for the person talking to you, from ' +
        'their own viewing. Use for "what should I watch?", "recommend me ' +
        'a movie", "something funny", "a good horror movie", "something ' +
        'like Harry Potter" (like), "...but darker" (like plus mood dark), ' +
        '"what should we watch as a family?" (forFamily), "something I ' +
        'haven\'t watched", "what sci-fi movies do I already have?" ' +
        '(genres plus includeWatched), "something around 90 minutes" ' +
        '(aroundMinutes), "what next, based on what I\'ve been watching" ' +
        '(basedOnHistory). What we already have comes first. Anything not ' +
        'in the library is only a suggestion: never add it unless they ' +
        'then ask you to.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['movie', 'show', 'any'] },
          mood: {
            type: 'string',
            enum: [
              'funny',
              'scary',
              'dark',
              'light',
              'exciting',
              'thoughtful',
              'romantic',
              'family',
            ],
          },
          genres: {
            type: 'array',
            items: { type: 'string' },
            description: 'e.g. ["sci-fi"], ["horror"], ["comedy"]',
          },
          like: {
            type: 'string',
            description: 'a title they want something similar to',
          },
          forFamily: { type: 'boolean' },
          maxMinutes: { type: 'number' },
          aroundMinutes: { type: 'number' },
          includeWatched: {
            type: 'boolean',
            description:
              'true when they want to know what we have, watched or not',
          },
          wantNew: {
            type: 'boolean',
            description:
              'true only when they ask for something new or something we ' +
              'do not have',
          },
          basedOnHistory: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description:
        'THE CATALOGUE — every film and show that exists in the world, ' +
        'whether or not this family owns it. Use it only when they are ' +
        'explicitly asking to ADD something ("add Dune to the server"), or ' +
        'to identify a title. A result here does NOT mean it can be played: ' +
        'only find_something_to_watch can tell you that.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['movie', 'series'],
            description: 'film or tv show; guess from what they said',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_show_availability',
      description:
        'For one show: which seasons the family has in full, which are part ' +
        'there, and which are missing entirely. Use before offering to add ' +
        'any of a show, and when they ask what is missing from one.',
      parameters: {
        type: 'object',
        properties: {
          seriesId: {
            type: 'number',
            description:
              'catalogue id from find_something_to_watch or search_catalog',
          },
        },
        required: ['seriesId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_to_library',
      description:
        'Put something on the family library list. Only ever after they have ' +
        'asked for it or said yes to an offer — never turn "I want to watch ' +
        'X" straight into this. Give ONE of: movieIds, or seriesId with ' +
        'seasons, or seriesId with episodes, or seriesId with missingOnly ' +
        'true for "get the rest of it".',
      parameters: {
        type: 'object',
        properties: {
          movieIds: {
            type: 'array',
            items: { type: 'number' },
            description: 'catalogue ids of films',
          },
          seriesId: { type: 'number' },
          seasons: {
            type: 'array',
            items: { type: 'number' },
            description: 'season numbers; leave out for the whole show',
          },
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
          missingOnly: {
            type: 'boolean',
            description:
              'true for "get whatever we are missing" — works out the gaps ' +
              'and asks only for those',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tvs',
      description:
        'The TVs in the house something can be played on right now. Use when ' +
        'they ask what TVs there are, or before playing if they have not said.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_on_tv',
      description:
        'Start something playing on a TV. Only ids that came back from ' +
        'find_something_to_watch or what_was_i_watching, and a TV name ' +
        'from list_tvs. A film they are part way through picks up where ' +
        'they left off unless they ask to start over. Repeat what this ' +
        'returns about where it started — some TVs can only start from ' +
        'the beginning, and you must not say it picked up when it did not.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          tv: {
            type: 'string',
            description: 'the TV name, e.g. "living room"',
          },
          from: {
            type: 'string',
            enum: ['auto', 'resume', 'start'],
            description:
              '"resume" for "continue X" or "carry on with X"; "start" for ' +
              '"start X over" or "from the beginning"; otherwise leave it out',
          },
        },
        required: ['itemId', 'tv'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_show',
      description:
        'Put a SHOW from the library on a TV for the person talking to you, ' +
        'working out the episode from their own viewing. Use it for: ' +
        '"continue The Office" / "continue my show" (action continue); ' +
        '"play the next episode" / "next episode of The Office" (action ' +
        'next — always the one AFTER the episode they are on, even if that ' +
        'one is only part watched); "start The Office over" (action ' +
        'start_over); "play The Office S03E12" or "season 3 episode 12" ' +
        '(action episode, with season and episode; add from "start" only ' +
        'if they asked to start that episode over). Leave show out only for ' +
        '"continue my show" or "play the next episode" with no show named. ' +
        'Ask which TV if they have not said. Repeat what it returns about ' +
        'where it started — never say it picked up when it did not.',
      parameters: {
        type: 'object',
        properties: {
          show: { type: 'string', description: 'the show as they said it' },
          tv: { type: 'string', description: 'the TV name' },
          action: {
            type: 'string',
            enum: ['continue', 'next', 'start_over', 'episode'],
          },
          season: { type: 'number' },
          episode: { type: 'number' },
          from: { type: 'string', enum: ['auto', 'start'] },
        },
        required: ['tv', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'what_was_i_watching',
      description:
        'What the person talking to you has watched lately — films and ' +
        'shows together, most recent first, each with a ready-made line. ' +
        'Use for "what was I watching?". For "continue my movie", play the ' +
        'most recent film that is part way with play_on_tv and from ' +
        '"resume"; for "continue my show", use play_show instead.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'how_far_into',
      description:
        'How far the person talking to you is through a film or a show: ' +
        '"how far am I into Jaws?", "where am I up to in The Office?". For ' +
        'a show, pass its name as show. For a film, find it with ' +
        'find_something_to_watch first and pass its itemId.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          show: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_tv',
      description:
        'Stop whatever is playing on a TV. Call this every time they ask to ' +
        'stop, turn off or end what is on a TV — the TV only stops when this ' +
        'is called, so never say a TV has stopped unless this returned.',
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
      name: 'what_am_i_waiting_for',
      description:
        'What the person talking to you asked to be added that has just ' +
        'become ready, and what is still on its way, with how far along it ' +
        'really is. Use for "what am I waiting for?", "how far along is my ' +
        'movie?", "is my show ready yet?".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_media_request_status',
      description:
        'How things on the library list are getting on, for the whole ' +
        'family. Use for "is Dune here yet?", "what\'s happening with ' +
        'Dune?", "what are we waiting on?". Repeat the status words it ' +
        'gives; never make up a percentage or a time.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'optional title to narrow to' },
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
