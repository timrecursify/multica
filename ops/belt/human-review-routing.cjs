"use strict";

const HUMAN_REVIEW_CATEGORIES = new Set(["money", "structural", "irreversible_production"]);
const MONEY_TERMS = [
  "real money", "client charge", "charge client", "issue refund", "client refund",
  "change client pricing", "invoice amount", "make payout", "client billed",
  "customer billed", "payment amount"
];
const STRUCTURAL_TERMS = [
  "expensive to reverse", "no migration back", "irreversible production", "irreversible prod",
  "retire canonical", "replace canonical", "canonical component", "fleet contract",
  "fundamental architecture", "structural architecture"
];

function explicitCategory(ticket) {
  const metadata = ticket?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const category = String(metadata.human_review_category || "").trim().toLowerCase();
  return HUMAN_REVIEW_CATEGORIES.has(category) ? category : null;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

// Sole semantic classifier for Human Review. Unknown, vague, and merely
// technical work deliberately returns null so Astra decides it in Spec.
function humanReviewCategory(ticket) {
  const explicit = explicitCategory(ticket);
  if (explicit) return explicit;
  const text = [ticket?.title, ticket?.description, ticket?.reason]
    .filter((value) => typeof value === "string").join("\n").toLowerCase();
  if (includesAny(text, MONEY_TERMS)) return "money";
  if (includesAny(text, STRUCTURAL_TERMS)) return "structural";
  return null;
}

function isHumanReviewEligible(ticket) {
  return humanReviewCategory(ticket) !== null;
}

function humanReviewDestination(ticket) {
  return isHumanReviewEligible(ticket) ? "Human Review" : "Spec";
}

module.exports = { HUMAN_REVIEW_CATEGORIES, humanReviewCategory, isHumanReviewEligible, humanReviewDestination };
