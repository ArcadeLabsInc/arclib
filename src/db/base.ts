import { Collection, Database, DatabaseAdapter, Model, Q } from '@nozbe/watermelondb';
import { field, text, json } from '@nozbe/watermelondb/decorators';
import { schemaMigrations } from '@nozbe/watermelondb/Schema/migrations';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { AppSchema, TableName } from './schema';
import { NostrEvent } from '../ident';
import { Filter, matchFilter } from 'nostr-tools';
import { Class } from '@nozbe/watermelondb/types';

export class DbEvent extends Model {
  static table = TableName.EVENTS;

  @field('event_id') event_id: string;
  @text('content') content!: string;
  @text('sig') sig: string;
  @field('kind') kind: number;
  @text('pubkey') pubkey: string;
  @json('tags', (rawTags: string[][]): string[][] => {
    return Array.isArray(rawTags) ? rawTags : [];
  })
  tags: string[][];
  @field('created_at') created_at: number;
  @field('verified') verified: boolean;
  @field('e1') e1: string;
  @field('p1') p1: string;


  private static fillPost(post: DbEvent, event: NostrEvent, verified: boolean) {
    post.event_id = event.id;
    post.content = event.content;
    post.sig = event.sig;
    post.kind = event.kind ;
    post.tags = event.tags;
    post.pubkey = event.pubkey;
    post.created_at = event.created_at;
    post.verified = verified;
    event.tags.forEach((tag) => {
      if (tag[0] == 'e' && !post.e1) {
        post.e1 = tag[1];
      }
      if (tag[0] == 'p' && !post.p1) {
        post.p1 = tag[1];
      }
    });
  }

  public static prepareEvent(
    db: Database,
    event: NostrEvent,
    verified = false
  ): DbEvent {
    const posts: Collection<DbEvent> = db.collections.get(DbEvent.table);
    return posts.prepareCreate((post: DbEvent) => {
        DbEvent.fillPost(post, event, verified);
      });
   }
 
  public static async fromEvent(
    db: Database,
    event: NostrEvent,
    verified = false
  ): Promise<DbEvent> {
    const posts: Collection<DbEvent> = db.collections.get(DbEvent.table);
    const have = await posts.query(Q.where('event_id', event.id)).fetch();

    if (have.length) {
      return have[0] as DbEvent;
    }

    return await db.write(async () => {
      return await posts.create((post: DbEvent) => {
        DbEvent.fillPost(post, event, verified);
      });
    });
  }

  asEvent(): NostrEvent {
    return {
      id: this.event_id,
      kind: this.kind,
      pubkey: this.pubkey,
      sig: this.sig,
      content: this.content,
      tags: this.tags,
      created_at: this.created_at,
    };
  }
}

export class ArcadeDb extends Database implements ArcadeDb {
  queue: Map<string, NostrEvent>
  timer: NodeJS.Timeout | null;

  constructor(args: { adapter: SQLiteAdapter | DatabaseAdapter; modelClasses: (typeof DbEvent)[] | Class<Model>[] | Model[]; }) {
    super(args);
    this.queue = new Map()
    this.timer = null
  }

  async list(filter: Filter[]): Promise<NostrEvent[]> {
    const posts: Collection<DbEvent> = this.collections.get(DbEvent.table);
    const or: Q.Where = this.filterToQuery(filter);
    const records = await posts.query(or).fetch();
    const seen = new Set()
    const els = records.map((ev: DbEvent) => {
      if (!seen.has(ev.id)) {
        seen.add(ev.id)
        return ev.asEvent();
      }
    }).filter(e=>e) as NostrEvent[];
    for (const ev of this.queue.values()) {
      if (! seen.has(ev.id) && filter.some((f) => matchFilter(f, ev))) {
        els.push(ev)
      }
    }
    return els
  }

  async latest(filter: Filter[]): Promise<number> {
    const posts: Collection<DbEvent> = this.collections.get(DbEvent.table);
    const or: Q.Where = this.filterToQuery(filter);
    const records = await posts.query(or).fetch();
    return records.length
      ? records.reduce((prev, cur) => {
          return cur && cur.created_at > prev.created_at ? cur : prev;
        }).created_at
      : 0;
  }

  private filterToQuery(filter: Filter[]) {
    const or: Q.Where[] = [];
    filter.forEach((f) => {
      const and: Q.Where[] = [];
      if (f.authors)
        and.push(Q.where('pubkey', Q.oneOf(f.authors)))
      if (f.ids)
        and.push(Q.where('event_id', Q.oneOf(f.ids)))
      if (f.kinds)
        and.push(Q.where('kind', Q.oneOf(f.kinds)))
      if (f['#e'])
        and.push(Q.where('e1', Q.oneOf(f['#e'])))
      if (f['#p'])
        and.push(Q.where('p1', Q.oneOf(f['#p'])))
      or.push(Q.and(...and));
    });
    return Q.or(...or);
  }

  async saveEvent(ev: NostrEvent) {
    this.queue.set(ev.id, ev)
    if (! this.timer ) {
      this.timer = setTimeout(this.flush, 500)
    }
  }

  async flush() {
    const t = this.timer
    this.timer = null
    if (t) clearTimeout(t)
    if (!this.queue) return
    const q = Array.from(this.queue.values())
    this.queue = new Map()
    await this.batch(q.map((ev)=> {
      return DbEvent.prepareEvent(this, ev, false)
    }))
  }
}

export function connectDb(): ArcadeDb {
  const adapter = new SQLiteAdapter({
    schema: AppSchema,
    migrations: schemaMigrations({
      migrations: [],
    }),
    onSetUpError: (error: unknown): void => {
      console.log('setup error', error);
    },
  });

  const db = new ArcadeDb({
    adapter,
    modelClasses: [DbEvent],
  });

  return db;
}