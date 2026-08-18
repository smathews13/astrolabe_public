/**
 * What was built, and whether the two halves were built from the same thing.
 *
 * The app and the orchestrator are released separately, so a deployment can be
 * running an app from one commit against a model logged from another. That is
 * the single most expensive fact to be wrong about on this page: every value
 * below it is read back from one half or the other, and two halves from
 * different commits can disagree about the deployment while both report
 * honestly.
 *
 * IT USED TO BE A CLAUSE IN A SENTENCE. The status block's meta line read `app
 * build abc1234 · orchestrator build def5678 · the served model version did not
 * report its own configuration · recorded values readable`, in 12px grey,
 * directly under a headline about reachability. Nothing about it said the two
 * hashes were a comparison, so the one reader who would act on a mismatch had
 * to notice it by eye, and the mismatch was the only reason to print either.
 *
 * So the comparison is made here and the answer is what the page draws.
 *
 * `+dirty` NEVER LEAVES THIS MODULE. `scripts/bundle-server.mjs` stamps the
 * suffix onto a build made from a working tree with uncommitted changes, which
 * is a real and useful fact -- and it is a fact about the BUILD, not part of the
 * commit. Rendered as text it produced `abc1234+dirty` on screen, which is not a
 * hash anybody can look up, and pasted into `git show` it fails. So the suffix
 * becomes a chip, the hash renders short, and the clipboard gets the commit on
 * its own.
 */

/** The suffix `scripts/bundle-server.mjs` stamps on a build from a dirty tree. */
const DIRTY_SUFFIX = '+dirty';

/** How much of a hash the page prints. The rest is copy and `title` content. */
export const SHORT_SHA_LENGTH = 8;

/** The commit, without the build's opinion of the working tree. */
export function commitOf(sha: string): string {
  const trimmed = sha.trim();
  return trimmed.endsWith(DIRTY_SUFFIX) ? trimmed.slice(0, -DIRTY_SUFFIX.length) : trimmed;
}

/** Whether this artifact was built from a tree with uncommitted changes. */
export function builtDirty(sha: string): boolean {
  return sha.trim().endsWith(DIRTY_SUFFIX);
}

/**
 * The shortest stamp this module will compare, in characters.
 *
 * Seven, which is git's own default abbreviation length and the shortest form
 * `git log --oneline` will print. Below it a "match" stops meaning anything: two
 * hex characters agree between one commit in every 256, so a four-character
 * comparison on a repository of any size is a coin toss reported as a release
 * verdict. A stamp under the floor is therefore not compared at all rather than
 * compared leniently.
 */
export const MIN_ABBREV = 7;

/**
 * What the two stamps establish about each other.
 *
 * `uncompared` and `unidentifiable` are both "no answer" and they are NOT the
 * same absence. One half reporting nothing is an absence of a stamp, and the half
 * that did report is still a fact worth stating plainly. A stamp that arrived and
 * is too short to identify a commit is an absence of a COMPARISON: something was
 * reported, it cannot be checked against the other, and letting it pass as
 * agreement would be the badge lying.
 */
export type CommitAgreement = 'same' | 'different' | 'unidentifiable' | 'uncompared';

/**
 * Whether two build stamps name the same commit.
 *
 * PREFIX, AS GIT DEFINES IT, AND NOT AN EXACT STRING MATCH. The two stamps come
 * from two producers, so they can arrive at different lengths -- and an exact
 * match would then call one commit two, which is worse than the failure it
 * prevents: it reports drift on a release that has none, at exactly the moment
 * somebody is watching these chips turn green, and the reflex under that pressure
 * is to loosen the check. An abbreviated hash identifies a commit when it is a
 * prefix of it, which is the rule `git show abc1234` already works by.
 *
 * The comparison is case-folded because a hash is hex and git accepts either
 * case; `ABC1234` and `abc1234` are one commit, not two.
 *
 * WHAT IT CANNOT CATCH, stated because it is the reason to fix this upstream:
 * two genuinely different commits whose hashes agree over the whole of the
 * shorter stamp read as one. At the seven-character floor that is one pair in
 * 268 million, and it is a real hole rather than a rounding one -- the only fix
 * for it is both producers recording the full forty characters, which makes the
 * prefix and the exact match the same test.
 */
export function compareCommits(appSha: string, modelSha: string): CommitAgreement {
  const app = commitOf(appSha).toLowerCase();
  const model = commitOf(modelSha).toLowerCase();
  if (!app || !model) return 'uncompared';
  if (app.length < MIN_ABBREV || model.length < MIN_ABBREV) return 'unidentifiable';
  const [shorter, longer] = app.length <= model.length ? [app, model] : [model, app];
  return longer.startsWith(shorter) ? 'same' : 'different';
}

/**
 * One artifact's row in the Build card.
 *
 * `full` is what the copy button puts on the clipboard and what the `title`
 * carries; `short` is the only part that renders. `tone` is `plain` where there
 * is no commit at all, because an unset value is not a failing one -- the row
 * says `not set` and stays quiet, which is the page's rule everywhere else.
 *
 * The tones are `StatusBadge`'s, spelled out rather than imported, so that this
 * module stays free of the markup it decides for.
 */
export interface BuildArtifact {
  key: string;
  label: string;
  short: string;
  full: string;
  tone: 'reachable' | 'blocked' | 'plain';
}

export interface BuildFacts {
  artifacts: BuildArtifact[];
  /**
   * Why the rows are red, one short line per condition that holds, in the order
   * the design states them. Empty on a clean matched build, so nothing renders.
   *
   * THESE USED TO BE TWO-WORD CHIPS ON THE CARD'S HEADER STRIP -- `Different
   * commits`, `Uncommitted changes` -- four rows above the badges they explained.
   * Sam read the live card as two bright red hashes with no reason given, which
   * is what a reader gets from a chip that far from the thing it qualifies and
   * that short: `Different commits` does not say WHICH two things differ. So each
   * condition is now a line beside the rows it is about, and it names the halves.
   *
   * One line per condition and nowhere else on the page. A red badge whose reason
   * is stated twice reads as two problems.
   */
  notes: string[];
  /** Whether the two artifacts name different commits. Both are then red. */
  differ: boolean;
}

/**
 * The card's whole content, from the two hashes the settings payload carries.
 *
 * Green is the narrow claim: this artifact was built from a committed tree AND
 * the other artifact was built from the same commit. Anything short of that is
 * red, because both shortfalls mean the same thing to a reader -- what is
 * running cannot be identified from a commit alone.
 *
 * `differ` requires BOTH hashes. One half reporting nothing is an absence rather
 * than a disagreement, and calling it a mismatch would put a red chip on every
 * deployment whose model version predates the field. That is the same line the
 * connection statuses draw between a refusal and a row nobody checked, and it is
 * why an unreported hash comes out `plain` and unexplained rather than red: there
 * is nothing to explain about a value nobody sent.
 *
 * THE COMPARISON IS A PREFIX TEST WITH A FLOOR, not an exact string match. See
 * `compareCommits` for the rule and for what it cannot catch. It was an exact
 * match, which was wrong in a way that mattered: the two stamps come from two
 * producers, and the first release cut from ONE commit would have been reported
 * as drift the moment those producers disagreed about how long a hash is.
 *
 * A stamp too short to identify a commit is neither. It is not green, because
 * nothing was established, and it is not red, because nothing was contradicted --
 * so it comes out untinted with a line saying why, which is the same treatment
 * this page gives every other unsettled state.
 */
export function buildFacts(input: { appBuildSha: string; modelBuildSha: string }): BuildFacts {
  const app = input.appBuildSha.trim();
  const model = input.modelBuildSha.trim();
  const agreement = compareCommits(app, model);
  const differ = agreement === 'different';
  const dirty = builtDirty(app) || builtDirty(model);

  const artifact = (key: string, label: string, sha: string): BuildArtifact => {
    const commit = commitOf(sha);
    if (!commit) return { key, label, short: '', full: '', tone: 'plain' };
    return {
      key,
      label,
      short: commit.slice(0, SHORT_SHA_LENGTH),
      full: commit,
      // `uncompared` keeps its green: the half that reported is a whole fact on
      // its own, and the other half never arriving is not a mark against it.
      tone: builtDirty(sha) || differ ? 'blocked' : agreement === 'unidentifiable' ? 'plain' : 'reachable',
    };
  };

  return {
    artifacts: [artifact('app', 'App', app), artifact('orchestrator', 'Orchestrator', model)],
    // Each names the condition and the halves it is about, because "why is this
    // red" is the whole question a reader brings to this card. Not a generic
    // error: the mismatch is a normal consequence of releasing the app and the
    // model separately, and a line that said "error" would send somebody looking
    // for a fault instead of at the release order.
    notes: [
      differ ? 'Different commits: the app and the orchestrator were not built from the same one.' : '',
      // Says which way the reading failed, because "too short" is a fact about
      // the stamp and not about the release: the two halves may well agree, and
      // this card cannot tell. Naming the floor is what makes it actionable.
      agreement === 'unidentifiable'
        ? `Not comparable: a stamp shorter than ${MIN_ABBREV} characters does not identify a commit, so ` +
          'whether these two agree is unknown.'
        : '',
      dirty ? 'Uncommitted changes: one half was built from a tree with edits that were never committed.' : '',
    ].filter(Boolean),
    differ,
  };
}
