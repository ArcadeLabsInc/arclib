import { ArcadeIdentity, NostrEvent } from "./ident";
import { NostrPool } from "./pool";
import { EventTemplate, Filter } from "nostr-tools";

const STALE_GRAPH = 1000 * 60 * 60 * 24 * 7 // 1 week
const GRAPH_DEPTH = 2

// define a nip02 tag type
type NIP02Contact = string[];
type PublicKey = string;
export type SocialGraphEntry = {
  pubkey: PublicKey,
  degree: number,
  connection: PublicKey, // For degree 1, this is always the user's own pubkey. For degree 2, this is the pubkey of the contact between us and this contactPubkey.
  // meta: {},
  lastUpdated: number, // timestamp is updated when this contact's social graph is updated
  fwf?: number, // (number of) friends who follow (this contact)
}
export type SocialGraph = {
  [key in PublicKey]: SocialGraphEntry;
}

/**
 * Ensure the provided ptag is a valid NIP02 contact we can work with.
 * @param ptag string[p, pubkey, relay?, pet name?]
 * @returns 
 */
export function isValidNIP02Contact(ptag: NIP02Contact): ptag is NIP02Contact {
  return Array.isArray(ptag) &&
    ptag.length >= 2 &&
    ptag.length <= 4 &&
    ptag.every(item => typeof item === 'string') &&
    ptag[0] === 'p' &&
    ptag[1].length === 64
}

/**
 * Pass this an EventTemplate array and it will return a function to use as the event handler for receiving events from the pool. It will validate them and put them into the provided array.
 * @param event from subscription
 * @returns 
 */
function validateContacts(events: EventTemplate[]) {
  const store = events;
  /**
   * Ensure the provided event is a valid kind 3 event or kind 0 event with contacts.
   */
  return function (event: EventTemplate): void {
    if (isValidKind3Kind0Event(event)) {
      // store the event
      store.push(event);
    }
  }
}

function isValidKind3Kind0Event(event: EventTemplate): boolean {
  return isValidKind3Event(event) || isKind0EventWithContacts(event)
}

function isValidKind3Event(event: EventTemplate): boolean {
  return event.kind === 3 &&
    typeof event.tags === 'object' &&
    typeof event.tags.length === 'number' &&
    event.tags.length > 0 &&
    event.tags.every(isValidNIP02Contact)
}

function isKind0EventWithContacts(event: EventTemplate): boolean {
  return event.kind === 0 &&
    event.tags.length > 0 &&
    event.tags.every(isValidNIP02Contact)
}

export class ArcadeSocial {
  public pool: NostrPool;
  private ident: ArcadeIdentity;
  public socialGraph: SocialGraph = {};
  public iteration = 0;
  public paused = false;
  // idle=true indicates that the graph is fully updated and now entering a mode where it is simply checking a contact once per second sequentially to see if they are no longer fresh based on STALE_GRAPH.
  public idle = false;
  private pausedOnKey: string | null = null;
  private pausedOnDegree = 1;
  constructor(pool: NostrPool, ident: ArcadeIdentity, autoStart = true) {
    this.pool = pool;
    this.ident = ident;
    if( autoStart ){
      this.start();
    }
  }
  /**
   * Stop social graph generation process and save where we left off.
   */
  pause(): void {
    this.paused = true;
  }
  /**
   * Start or restart graph generation process.
   */
  start() {
    this.paused = false;
    // start or restart
    this.extendGraph(this.pausedOnKey || this.ident.pubKey, this.pausedOnDegree);
  }
  /**
   * Provide a public key to extend the social graph by one degree. Hey that rhymes!
   * @param pubkey PublicKey - raw hex public key
   * @param degree the current degree of separation from the user in this iteration
   */
  extendGraph(pubkey: PublicKey, degree = 1): void {
    // an array to store this iteration of extendGraph()'s validated events; invalid events are discarded and don't make it into this array.
    const events: EventTemplate[] = [];

    // get event handler storeContacts for pool subscription
    const storeContacts = validateContacts(events);

    // set up a filter for pool subscription
    const filter: Filter<number> = { kinds: [3,0], authors: [pubkey] };

    const processEvents = async () => {
      // get contact list events from pool so we can find the most recent one
      // this will subscribe, get events from relays, store in database, and then return results from the database, hitting db in future rebuilds of social graph.
      const gotEvents = await this.pool.list([filter], false)

      if (gotEvents.length === 0) {
        // no events were received
        // console.warn('no events received for', pubkey)
        this.iterateGraph();
        return;
      }

      // store valid gotEvents in events array via storeContacts function.
      gotEvents.map(storeContacts)
      // stop using gotEvents now and use events instead.

      // sort to get the most recent event at the front
      events.sort((a, b) => b.created_at - a.created_at)

      try {
        const mostRecent = events[0]
        const mostRecentContacts = mostRecent.tags
        this.buildGraph(pubkey, mostRecentContacts, degree)
      } catch (error) {
        console.log('pubkey had no contacts', error)
        if (pubkey === this.ident.pubKey) {
          // this is the user's own pubkey. We should have contacts. Nothing more can be done.
          console.warn(pubkey,'go make some friends or you won\'t have a social graph');
          this.pause();
        } else {
          // this pubkey didn't have contacts. proceed to the next pubkey.
          this.iterateGraph()
        }
      }
      // return Promise.resolve();
    }
    processEvents()
  }
  async buildGraph(pubkey: PublicKey, contacts: string[][], degree: number): Promise<void> {
    // begin building social graph
    // iterate over contacts in most recent kind3
    // and store each pubkey in a flat socialGraph relative to the user.
    for (const contact of contacts) {
      if (
        isValidNIP02Contact(contact) &&
        contact[1] !== this.ident.pubKey // don't store the user's own pubkey
      ) {
        const contactPubkey = contact[1]
        if (Object.prototype.hasOwnProperty.call(this.socialGraph, contactPubkey)) {
          // this pubkey is already in our socialGraph.
          // increase its fwf (friends who follow) count
          // the fwf metric is only useful for the user's own social graph, but that's ok because so are the other metrics (like degree).
          this.socialGraph[contactPubkey].fwf = (this.socialGraph[contactPubkey].fwf || 0) + 1
        } else {
          // this pubkey is not in our socialGraph. Add it.
          this.socialGraph[contactPubkey] = {
            pubkey: contactPubkey,
            degree,
            connection: pubkey, // For degree 1, this is always the user's own pubkey. For degree 2, this is the pubkey of the contact between us and this contactPubkey.
            // meta: {},
            lastUpdated: 0, // timestamp is updated when this contact's social graph is updated
          }
        }
      }
    }

    // we just updated all the contacts for pubkey; update its lastUpdated timestamp
    if (Object.prototype.hasOwnProperty.call(this.socialGraph, pubkey)) {
      this.socialGraph[pubkey].lastUpdated = Date.now()
    }

    // this.analyze() // console log stuff about the graph as it is built.

    this.iterateGraph()

  }
  /**
   * Iterate over the social graph and update each contact's social graph if it is stale
   * Iteration should not move to the next degree until all contacts in the current degree have been updated - breadth first instead of depth first for good UX.
   */
  iterateGraph() {
    const now = Date.now()
    const graphKeys = Object.keys(this.socialGraph)
    if (this.paused) {
      // save where we left off for when we restart.
      this.pausedOnKey = graphKeys[this.iteration];
      this.pausedOnDegree = this.socialGraph[this.pausedOnKey].degree;
      return;
    }
    if (graphKeys.length === 0) {
      // the first pubkey yielded no contacts. We're done.
      console.warn('Please supply a pubkey with contacts to build a social graph.')
      this.pausedOnKey = null
      this.pausedOnDegree = 1
      return
    }
    if (this.iteration >= graphKeys.length) {
      // we've completed the graph. start over to continue refreshing it.
      // this process will stop when someone calls .pause()
      this.iteration = 0
    }
    // get contact
    const contact = graphKeys[this.iteration]
    // if the contact's social graph is stale and < GRAPH_DEPTH degree, update it
    if (
      now - this.socialGraph[contact].lastUpdated > STALE_GRAPH && 
      this.socialGraph[contact].degree + 1 <= GRAPH_DEPTH
    ) {
      this.idle = false
      this.extendGraph(contact, this.socialGraph[contact].degree + 1)
      this.iteration++
    } else {
      // keep iterating
      // once per second to avoid resource hogging 
      this.iteration++
      this.idle = true
      setTimeout( () => this.iterateGraph(),1000)
    }
  }
  /**
   * show when each contact was last updated
   * currently unused outside of the console
   * @returns an array of pubkeys sorted by lastUpdated
   */
  lastUpdate(){
    return Object.keys(this.socialGraph).sort( (a,b) => this.socialGraph[b].lastUpdated - this.socialGraph[a].lastUpdated ).map( pk => `${(((+new Date()) - this.socialGraph[pk].lastUpdated)/1000/60).toFixed(1) + 'm ago'} - 0x${pk.substring(0,6)} ` )
  }
  /**
   * Given a pubkey, return the pubkeys between you and it or an empty array if none.
   * Your own pubkey and the given pubkey are omitted from the array.
   * @param pubkey 
   * @returns array hops between you and pubkey
   */
  hops(pubkey: string) {
    const path = []
    let current = this.socialGraph[pubkey]
    while (current.degree > 1) {
      path.unshift(current.connection)
      current = this.socialGraph[current.connection]
    }
    return path
  }
  /**
   * Social Distance from you to your pubkey is 0. Distance to someone you follow (friend) is 1. Distance to their friend is 2. Distances beyond this or unknown distances are 3.
   * https://github.com/ArcadeLabsInc/arcade/wiki/ArcTrust-Reputation-via-Social-Graph-and-NIP-32
   * @param pubkey 
   * @returns number - social distance from you to pubkey
   */
  distance(pubkey: string) {
    if (pubkey === this.ident.pubKey) return 0
    if (!this.socialGraph[pubkey]) return 3
    return this.socialGraph[pubkey].degree
  }
  weight(pubkey: string){
    const distance = this.distance(pubkey)
    if (distance === 0) return 10_000
    return 1 / ( distance * distance )
  }
  async getReputation(pubkey: string){
    // get all kind 1985 events for this pubkey
    const filter: Filter<number> = {
      kinds: [1985],
      "#p": [pubkey],
    };
    try {
      const events = await this.pool.list([filter], false)
      // for each event author, get only the most recent event by created_at
      type Ratings = {
        [pubkey: string]: NostrEvent
      }
      const ratings: Ratings = {}
      for (const event of events) {
        if (!ratings[event.pubkey]) {
          ratings[event.pubkey] = event
        } else {
          if (event.created_at > ratings[event.pubkey].created_at) {
            ratings[event.pubkey] = event
          }
        }
      }
      type RatingScalar = {
        [pubkey: string]: number
      }
      const ratingScores: RatingScalar = {}
      // iterate through ratings and save valid ratings to ratingScores
      for (const author of Object.keys(ratings)) {
        const rating = ratings[author]
        const ratingTags = rating.tags
        // check if we have an array in the tags array with the first element of "l"
        const label = ratingTags.find( (tag) => Array.isArray(tag) && tag[0] === 'l' )
        if (!label) continue
        // check if the label array has a 4th element that contains stringified JSON
        const labelJSON = label[3]
        if (!labelJSON) continue
        // parse the JSON
        const labelObj = JSON.parse(labelJSON)
        // check if the JSON has a "quality" property
        const quality = labelObj.quality
        if (!quality) continue
        // check if the quality property is a number
        const qualityNumber = Number(quality)
        if (isNaN(qualityNumber)) continue
        // check if the quality number is between 0 and 1
        if (qualityNumber < 0 || qualityNumber > 1) continue
        // if all checks pass, add the quality number to the rating score for this author
        ratingScores[author] = qualityNumber
      }

      const ratingWeights: RatingScalar = {}
      const ratingScaledScore: RatingScalar = {}
      // iterate through valid ratingScores and calculate the weight and scaled score for each author
      for (const author of Object.keys(ratingScores)) {
        const weight = this.weight(author)
        ratingWeights[author] = weight
        ratingScaledScore[author] = weight * ratingScores[author]
      }

      // calculate the sum of the weights in ratingWeights
      const weightSum = Object.values(ratingWeights).reduce( (a,b) => a + b, 0)

      // calculate the sum of the scaled scores in ratingScaledScore
      const scaledScoreSum = Object.values(ratingScaledScore).reduce( (a,b) => a + b, 0)

      const weightedAverageScore = scaledScoreSum / weightSum

      // return the user's social score
      return weightedAverageScore
    } catch (error) {
      console.log(error)
    }
  }
}

