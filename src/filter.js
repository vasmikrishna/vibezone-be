// Small list of slurs and profanity masked in names and chat. Matching is whole-word and case-insensitive.
const BLOCKED = ['fuck', 'fucker', 'fucking', 'shit', 'bitch', 'cunt', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard', 'dick', 'pussy'];
const PATTERN = new RegExp(`\\b(${BLOCKED.join('|')})\\b`, 'gi');

const filterText = (text) => text.replace(PATTERN, (word) => '*'.repeat(word.length));

module.exports = { filterText };
