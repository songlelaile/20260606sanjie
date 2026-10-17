'use strict';
// Extracted without logic changes from the pinned plugin; see provenance.json.
function keywordMergeKey(value) {
    var text = value == null ? '' : ('' + value);
    try { text = text.normalize('NFKC'); } catch (e) {}
    return text.replace(/\s+/g, '').toLowerCase();
  }

function pushKeywordEvidence(target, values) {
    (values || []).forEach(function (value) {
      value = ('' + (value == null ? '' : value)).trim();
      if (value && target.indexOf(value) < 0) target.push(value);
    });
  }

function mergeKeywordSources(rankWords, deriveWords) {
    var byKey = Object.create(null), order = [];
    function add(word, sourceName) {
      if (!word) return;
      var key = keywordMergeKey(word.kw);
      if (!key) return;
      var item = byKey[key];
      if (!item) {
        item = byKey[key] = {
          kw: ('' + word.kw).trim(), pop: 0, rankPop: 0, derivePop: 0,
          sources: [], seedWords: [], rankEvidence: [], occurrenceCount: 0
        };
        order.push(key);
      }
      var source = word.source || sourceName || '词表';
      var pop = Math.max(0, Number(word.pop) || 0);
      item.pop = Math.max(item.pop, pop);
      if (source === '热词榜') item.rankPop = Math.max(item.rankPop, pop);
      if (source === '衍生词榜') item.derivePop = Math.max(item.derivePop, pop);
      item.occurrenceCount++;
      pushKeywordEvidence(item.sources, [source]);
      pushKeywordEvidence(item.seedWords, word.seedWords || []);
      pushKeywordEvidence(item.rankEvidence, word.rankEvidence || []);
    }
    (rankWords || []).forEach(function (word) { add(word, '热词榜'); });
    (deriveWords || []).forEach(function (word) { add(word, '衍生词榜'); });
    return order.map(function (key) { return byKey[key]; });
  }
module.exports = { keywordMergeKey, mergeKeywordSources };
