/**
 * Run the following to test only this file:
 * $ yarn test -- social.test.ts
 */
import 'websocket-polyfill';
import { NostrPool } from "../src/pool";
import {
  nip19,
  generatePrivateKey,
  getPublicKey,
} from 'nostr-tools';
import { ArcadeIdentity } from '../src/ident';
import { ArcadeSocial, SocialGraph } from '../src/social';
 
const DEFAULT_RELAYS = [
  "wss://relay.arcade.city",
  "wss://arc1.arcadelabs.co",
  "wss://welcome.nostr.wine",
  "wss://relay.nostr.band/all",
  "wss://nostr.mutinywallet.com",
  "wss://relay.snort.social",
  "wss://eden.nostr.land",
  "wss://nostr.fmt.wiz.biz",
  "wss://relay.damus.io",
  "wss://nostr-pub.wellorder.net",
  "wss://offchain.pub",
  "wss://nos.lol",
]

function getTestKeys() {
  const sk = generatePrivateKey();
  const nsec = nip19.nsecEncode(sk);
  const npub = getPublicKey(sk);
  return [nsec, npub]
}

// select a random element from an iterable
function randomPick(iterable: Array<string>){
  const index = Math.floor(Math.random() * iterable.length);
  return iterable[index];
}

describe('Tests for ArcadeSocial graph', () => {
  const [nsec, npub] = getTestKeys();
  const ident = new ArcadeIdentity(nsec, '1btcxxx', 'arkinox@getalby.com');
  // need a pubkey with friends to test
  ident.pubKey = 'ace09f0547f6a95ee1d08075a5a9bd61e1c1ffa361cb7890c65fa3a95fae004f';
  const pool = new NostrPool(ident);
  pool.setRelays(DEFAULT_RELAYS);
  const arcadeSocial = new ArcadeSocial(pool, ident);

  it('starts building a graph automatically',() => {
    // expect.assertions(8);
    expect.assertions(5);
    const waitForGraph = new Promise((resolve, reject) => {
      let count = 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function check() {
        count++;
        if (arcadeSocial.iteration > 1) {
          // arcadeSocial.pause();
          resolve(arcadeSocial.socialGraph);
        } else if (count >= 60) {
          reject('Graph was not built in time; aborted instead of waiting forever.');
        } else {
          setTimeout(check, 1000);
        }
      }
      check();
    });
    return waitForGraph.then(value => {
      const graph = value as SocialGraph;
      const pubkeys: Array<string> = Object.keys(graph);
      const randomPubkey: string = randomPick(pubkeys);
      expect(graph).toBeDefined();
      // graph shouldn't contain the user
      expect(pubkeys).not.toContain(npub)
      // graph shouldn't be empty
      expect(pubkeys.length).toBeGreaterThan(0);
      // should be pubkeys
      expect(randomPubkey.length).toBe(64);
      // social distance to self should be 0
      expect(arcadeSocial.distance(ident.pubKey)).toEqual(0);

      // distance tests: must be specific to a known pubkey with these relationships. arkinox's pubkey has these.
      // social distance to guy swan should be 1
      // expect(arcadeSocial.distance("b9e76546ba06456ed301d9e52bc49fa48e70a6bf2282be7a1ae72947612023dc")).toEqual(1);
      // social distance to umbrel should be 2
      // expect(arcadeSocial.distance("ea2e3c814d08a378f8a5b8faecb2884d05855975c5ca4b5c25e2d6f936286f14")).toEqual(2);
      // social distance to newly generated pubkey should be 3
      // expect(arcadeSocial.distance("84ac01809888b0ec74da0cc21dad839248f69cf4007c90ab2c56c21fa0eff545")).toEqual(3);
    });
  }, 1000 * 60 * 10);

  it('can be paused and resumed', () => {
    expect.assertions(2);
    // pause it
    arcadeSocial.pause();
    expect(arcadeSocial.paused).toBeTruthy();
    // resume it
    arcadeSocial.start();
    expect(arcadeSocial.paused).toBeFalsy();
  });

  it('can create a full graph', () => {
    expect.assertions(1);
    const waitForGraph = new Promise((resolve) => {
      let count = 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function check() {
        count++;
        if (arcadeSocial.idle || count >= 60 * 5) {
          arcadeSocial.pause();
          setTimeout(() => resolve(arcadeSocial.socialGraph), 1000);
        } else {
          setTimeout(check, 1000);
        }
      }
      check();
    });
    return waitForGraph.then(value => {
      const graph = value as SocialGraph;
      const pubkeys: Array<string> = Object.keys(graph);
      expect(pubkeys.length).toBeGreaterThan(0);
      console.log(`Graph contains ${pubkeys.length} pubkeys.`)
    });
  }, 1000 * 60 * 10);

  it('can show ratings', async () => {
    expect.assertions(5)
    /* do some ratings

      me:
      sk: eaa2a858a12be1991ea866360f98ae1d77f2e97f298fa1bcb57bdb1960dc26e0
      pk: ace09f0547f6a95ee1d08075a5a9bd61e1c1ffa361cb7890c65fa3a95fae004f

      alice
      sk: c01ef93928a408fc9a1810cfc8f841a45285dff47fac96db7115c7d1e8a4ed02
      pk: b22df7a39de5d169bc50b2c3c7300c5863a7478c7760281ec981811ecc973af6
      npub: npub1kgkl0guauhgkn0zsktpuwvqvtp36w3uvwaszs8kfsxq3anyh8tmqcnyrcu

      bob
      sk: 3c930e3755ac76a81f8918889d003a2dd568209c5b1a6ef29d992f7c61da7153
      pk: e6e8845c2ab84c8688e618fe625861205d5200826ad6a89f76608c2e7677a1aa

      clyde
      sk: c85d49cd5c39d7013c39795339ce2bbba9296767727dfa7a1d91e4217ce05b00
      pk: d0c92afe7c06cf99455949bb36a90a82afb0398b2a549942e1addaad2f389e20

      mallory
      sk: 5718c79154196e036b9270d9f63ba467843ab26a8bd10d9266dab5bfad217862
      pk: 2462c33d35897231b325c4f8b76f408a8ad95c394bdc2f585194c8e33fb1a6a5

      derek
      sk: 0886cb6273f39d13607d2075e0e34dd34216812f466edfc46ca55a9694a7f8a2
      pk: d181a9db28afaeb234713d3f72d85433bd4dc1f380837abe072fcc1902fbfabb

    */ 
    function rate(raterName: string, sk: string, quality: number, evalueePubkey: string, message: string) {
      const rater = new ArcadeIdentity(sk, '1btcxxx', 'arcade-test-'+raterName+'@getalby.com');
      const raterpool = new NostrPool(rater);
      raterpool.setRelays(DEFAULT_RELAYS);
      raterpool.send({
        kind: 1985,
        tags: [
          ["L", "city.arcade"],
          ["l", "social", "city.arcade", "{\"quality\":"+quality+"}"],
          ["p", evalueePubkey],
        ],
        content: message
      })
    }
    // alice rates derek
    rate('alice','c01ef93928a408fc9a1810cfc8f841a45285dff47fac96db7115c7d1e8a4ed02', 0.85,'d181a9db28afaeb234713d3f72d85433bd4dc1f380837abe072fcc1902fbfabb', 'cool guy')
    // bob rates derek
    rate('bob','3c930e3755ac76a81f8918889d003a2dd568209c5b1a6ef29d992f7c61da7153', 0.9,'d181a9db28afaeb234713d3f72d85433bd4dc1f380837abe072fcc1902fbfabb', 'really friendly')
    // clyde rates derek
    rate('clyde','c85d49cd5c39d7013c39795339ce2bbba9296767727dfa7a1d91e4217ce05b00', 0.60,'d181a9db28afaeb234713d3f72d85433bd4dc1f380837abe072fcc1902fbfabb', 'didnt talk much')
    // mallory rates derek badly
    rate('mallory','5718c79154196e036b9270d9f63ba467843ab26a8bd10d9266dab5bfad217862', 0.10,'d181a9db28afaeb234713d3f72d85433bd4dc1f380837abe072fcc1902fbfabb', 'jerk')
    /**
     * I follow Alice. She has a weight of 1. Her score is 0.85 * 1 = 0.85.
     * Alice follows Bob. Bob has a weight of 0.25. His score is 0.9 * 0.25 = 0.225.
     * Bob follow Clyde. Clyde has a weight of 0.111111111. His score is 0.6 * 0.111111111 = 0.0666666666.
     * Nobody follows Mallory. She has a weight of 0.111111111. Her score is 0.1 * 0.111111111 = 0.0111111111.
     * Derek's social score should be ~0.7833333333
     * weightsum = 1 + 0.25 + 0.111111111 + 0.111111111 = 1.472222222
     * scaledscoresum = 0.85 + 0.225 + 0.0666666666 + 0.0111111111 = 1.1527777777
     * weightedaveragescore = 1.1527777777 / 1.472222222 = ~0.7833333333
     */
    // alice's weight should be 1
    expect(arcadeSocial.weight('b22df7a39de5d169bc50b2c3c7300c5863a7478c7760281ec981811ecc973af6')).toBe(1)
    // bob's weight should be 0.25
    expect(arcadeSocial.weight('e6e8845c2ab84c8688e618fe625861205d5200826ad6a89f76608c2e7677a1aa')).toBe(0.25)
    // clyde's weight should be 0.111111111
    expect(arcadeSocial.weight('d0c92afe7c06cf99455949bb36a90a82afb0398b2a549942e1addaad2f389e20')).toBe(1/9)
    // mallory's weight should be 0.111111111
    expect(arcadeSocial.weight('2462c33d35897231b325c4f8b76f408a8ad95c394bdc2f585194c8e33fb1a6a5')).toBe(1/9)
    // show social score for derek
    const DerekRep = await arcadeSocial.getReputation('d181a9db28afaeb234713d3f72d85433bd4dc1f380837abe072fcc1902fbfabb')
    expect(DerekRep).toBeCloseTo(0.7830188679245284, 3)
    console.log('Derek rep:', DerekRep)
  }, 1000 * 60 * 2);
});
