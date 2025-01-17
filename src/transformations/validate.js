const _ = require('lodash');
const consola = require('consola');
const tldts = require('tldts');
const utils = require('../utils');
const ruleUtils = require('../rule');

const DOMAIN_PREFIX = '||';
const DOMAIN_SEPARATOR = '^';
const WILDCARD = '*';
const WILDCARD_DOMAIN_PART = '*.';

// TODO: Remove lodash from the project if possible

/**
 * The list of modifiers that limit the rule for specific domains.
 */
const ANY_PATTERN_MODIFIER = [
    'denyallow',
    'badfilter',
    // DNS-related modifiers.
    'client',
];

/**
 * The list of modifiers supported by hosts-level blockers.
 */
const SUPPORTED_MODIFIERS = [
    'important',
    '~important',
    'ctag',
    // DNS-related modifiers.
    'dnstype',
    'dnsrewrite',
    'ctag',
    // modifiers that limit the rule for specific domains
    ...ANY_PATTERN_MODIFIER,
];

/**
 * Max length of a blocking pattern
 */
const MAX_PATTERN_LENGTH = 5;

/**
 * Checks if the specified hostname is valid for a blocklist.
 *
 * @param {string} hostname - hostname to check
 * @param {string} ruleText - original rule text (for logging)
 * @param {boolean} allowedIP - flag to determine if IP validation is allowed
 * @param {boolean} hasLimitModifier - flag to determine if the rule has a limit modifier, e.g. denyallow
 * @returns {boolean} true if the hostname is okay to be in the blocklist.
 */
function validHostname(hostname, ruleText, allowedIP, hasLimitModifier) {
    const result = tldts.parse(hostname);

    if (!result.hostname) {
        consola.debug(`invalid hostname ${hostname} in the rule: ${ruleText}`);
        return false;
    }

    if (!allowedIP && result.isIp) {
        consola.debug(`invalid hostname ${hostname} in the rule: ${ruleText}`);
        return false;
    }

    if (result.hostname === result.publicSuffix && !hasLimitModifier) {
        consola.debug(`matching the whole public suffix ${hostname} is not allowed: ${ruleText}`);
        return false;
    }

    return true;
}

/**
 * Validates an /etc/hosts rule.
 *
 * We do one very simple thing:
 * 1. Validate all the hostnames
 * 2. Prohibit rules that block the whole public suffix
 * 3. Prohibit rules that contain invalid domain names
 *
 * @param {string} ruleText - rule text
 * @param {boolean} allowIP - flag to determine if IP validation is allowed
 * @returns {boolean} true if the rule is a valid /etc/hosts rule
 */
function validEtcHostsRule(ruleText, allowIP) {
    let props;
    try {
        props = ruleUtils.loadEtcHostsRuleProperties(ruleText);
    } catch (ex) {
        consola.error(`Unexpected incorrect /etc/hosts rule: ${ruleText}: ${ex}`);
        return false;
    }
    if (_.isEmpty(props.hostnames)) {
        consola.info(`The rule has no hostnames: ${ruleText}`);
        return false;
    }

    if (props.hostnames.some((h) => !validHostname(h, ruleText, allowIP))) {
        return false;
    }

    return true;
}

/**
 * Validates an adblock-style rule.
 *
 * 1. It checks if the rule contains only supported modifiers.
 * 2. It checks whether the pattern is not too wide (should be at least 5 characters).
 * 3. If checks if the pattern does not contain characters that cannot be in a domain name.
 * 4. For domain-blocking rules like ||domain^ it checks that the domain is
 * valid and does not block too much.
 *
 * @param {string} ruleText - rule text
 * @param {boolean} allowedIP - flag to determine if IP validation is allowed
 * @returns {boolean} - adblock-style rule
 */
function validAdblockRule(ruleText, allowedIP) {
    let props;
    try {
        props = ruleUtils.loadAdblockRuleProperties(ruleText);
    } catch (ex) {
        consola.debug(`This is not a valid adblock rule: ${ruleText}: ${ex}`);
        return false;
    }

    // need to check if rules with TLD has limit modifier
    let hasLimitModifier = false;

    // 1. It checks if the rule contains only supported modifiers.
    if (props.options) {
        // eslint-disable-next-line no-restricted-syntax
        for (const option of props.options) {
            if (SUPPORTED_MODIFIERS.indexOf(option.name) === -1) {
                consola.debug(`Contains unsupported modifier ${option.name}: ${ruleText}`);
                return false;
            }
            // if the rule has a limit modifier, TLD as a hostname is allowed
            if (ANY_PATTERN_MODIFIER.includes(option.name)) {
                hasLimitModifier = true;
            }
        }
    }

    // 2. It checks whether the pattern is not too wide (should be at least 5 characters).
    if (props.pattern.length < MAX_PATTERN_LENGTH) {
        consola.debug(`The rule is too short: ${ruleText}`);
        return false;
    }

    // 3. If checks if the pattern does not contain characters that cannot be in a domain name.

    // 3.1. Special case: regex rules
    // Do nothing with regex rules -- they may contain all kinds of special chars
    if (_.startsWith(props.pattern, '/')
        && _.endsWith(props.pattern, '/')) {
        return true;
    }

    // However, regular adblock-style rules if they match a domain name
    // a-zA-Z0-9- -- permitted in the domain name
    // *|^ -- special characters used by adblock-style rules
    // One more special case is rules starting with ://s
    let toTest = props.pattern;
    if (_.startsWith(toTest, '://')) {
        toTest = _.trimStart(toTest, '://');
    }

    const checkChars = /^[a-zA-Z0-9-.*|^]+$/.test(toTest);
    if (!checkChars) {
        consola.debug(`The rule contains characters that cannot be in a domain name: ${ruleText}`);
        return false;
    }

    // 4. Validate domain name
    // Note that we don't check rules that contain wildcard characters
    const sepIdx = props.pattern.indexOf(DOMAIN_SEPARATOR);
    const wildcardIdx = props.pattern.indexOf(WILDCARD);
    if (sepIdx !== -1 && wildcardIdx !== -1 && wildcardIdx > sepIdx) {
        // Smth like ||example.org^test* -- invalid
        return false;
    }

    // Check if the pattern does not start with the domain prefix and does not contain a domain separator
    if (!_.startsWith(props.pattern, DOMAIN_PREFIX) || sepIdx === -1) {
        return true;
    }

    // Extract the domain to check from the rule text
    const domainToCheck = utils.substringBetween(ruleText, DOMAIN_PREFIX, DOMAIN_SEPARATOR);

    // If there are wildcard characters in the pattern
    if (wildcardIdx !== -1) {
        // Check if the rule has wildcard characters but includes only TLD (e.g., ||*.org^ or ||*.co.uk^)
        const startsWithWildcard = domainToCheck.startsWith(WILDCARD_DOMAIN_PART);
        // Get the TLD pattern to check (e.g. ||*.org^ --> org)
        const TLDPattern = domainToCheck.replace(WILDCARD_DOMAIN_PART, '');
        // Compare the TLD pattern with the public suffix
        const isOnlyTLD = tldts.getPublicSuffix(TLDPattern) === TLDPattern;
        // If it's a wildcard with TLD, validate the cleaned TLD
        if (startsWithWildcard && isOnlyTLD) {
            const cleanedDomain = domainToCheck.replace(WILDCARD_DOMAIN_PART, '');
            return validHostname(cleanedDomain, ruleText, allowedIP, hasLimitModifier);
        }
        // If the rule has wildcard characters but is not a TLD (e.g., ||*.example.org^)
        return true;
    }

    // Validate the domain
    if (!validHostname(domainToCheck, ruleText, allowedIP, hasLimitModifier)) {
        return false;
    }

    // Ensure there's nothing after the domain separator unless it's `^|`
    // If there's something after ^ in the pattern - something went wrong
    // unless it's `^|` which is a rather often case
    // ||example.org^| -- valid
    // @@||example.org^|$important -- invalid
    return !(props.pattern.length > (sepIdx + 1) && props.pattern[sepIdx + 1] !== '|');
}

/**
 * Validates the rule.
 *
 * Empty strings and comments are considered valid.
 *
 * For /etc/hosts rules: @see {@link validEtcHostsRule}
 * For adblock-style rules: @see {@link validAdblockRule}
 *
 * @param {string} ruleText - rule to check
 * @param {boolean} allowedIP - flag to determine if IP validation is allowed
 * @returns {boolean} - true if the rule is valid, false otherwise
 */
function valid(ruleText, allowedIP) {
    if (ruleUtils.isComment(ruleText) || _.isEmpty(_.trim(ruleText))) {
        return true;
    }

    if (ruleUtils.isEtcHostsRule(ruleText)) {
        return validEtcHostsRule(ruleText, allowedIP);
    }

    return validAdblockRule(ruleText, allowedIP);
}

/**
 * Class representing a validator for a list of rules.
 */
class Validator {
    constructor(allowedIP) {
        /**
         * Indicates whether the previous rule was removed.
         * @type {boolean}
         */
        this.prevRuleRemoved = false;
        /**
         * Flag to allow IP validation.
         * @type {boolean}
         */
        this.allowedIP = allowedIP;
    }

    /**
     * Validates the list of rules and removes invalid rules.
     * If a rule is invalid, any preceding comments or empty lines are also removed.
     *
     * @returns {Array<string>} The filtered list of valid rules.
     * @param {Array<string>} rules - An array of rules to validate.
     */
    validate(rules) {
        /**
         * A filtered list of rules after validation.
         * @type {Array<string>}
         */
        const filtered = [...rules];
        for (let iFiltered = filtered.length - 1; iFiltered >= 0; iFiltered -= 1) {
            const ruleText = filtered[iFiltered];

            if (!valid(ruleText, this.allowedIP)) {
                this.prevRuleRemoved = true;
                filtered.splice(iFiltered, 1);
            } else if (this.prevRuleRemoved && (ruleUtils.isComment(ruleText) || _.isEmpty(ruleText))) {
                // Remove preceding comments and empty lines
                consola.debug(`Removing a comment preceding invalid rule: ${ruleText}`);
                filtered.splice(iFiltered, 1);
            } else {
                // Stop removing comments
                this.prevRuleRemoved = false;
            }
        }

        return filtered;
    }
}
/**
 * Validates a list of rules.
 *
 * @param {Array<string>} rules - The array of rules to validate.
 * @param {boolean} allowedIP -  flag to allow IP validation.
 * @returns {Array<string>} The filtered list of valid rules.
 */
function validate(rules) {
    const validator = new Validator(false);
    // ip is not allowed for default validation
    return validator.validate(rules);
}

module.exports = {
    validate,
    Validator,
};
