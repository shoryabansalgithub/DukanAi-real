'use strict';
// Artillery processor for load/pos-peak.yml (roadmap 5.8). Reads the state
// written by setup.mjs (one token, product and credential set per shop) and gives every checkout
// a fresh idempotency key so no two virtual users collide on the same sale.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let state;
function readState() {
  if (!state) {
    const file = process.env.LOAD_STATE_FILE || path.join(__dirname, '.state.json');
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return state;
}

let next = 0;
/** Each virtual user acts for one shop; shops are taken round-robin so the load is spread over the fleet. */
function loadState(context, _events, done) {
  const s = readState();
  const shop = s.shops[next++ % s.shops.length];
  context.vars.token = shop.token;
  context.vars.productId = shop.productId;
  context.vars.unitPrice = s.unitPrice;
  context.vars.email = shop.email;
  context.vars.password = shop.password;
  return done();
}

function newCheckout(context, _events, done) {
  const quantity = 1 + Math.floor(Math.random() * 3);
  context.vars.idempotencyKey = randomUUID();
  context.vars.quantity = quantity;
  // ZERO-GST product with no discount: the total is quantity x price (2 dp).
  context.vars.amount = Number((quantity * context.vars.unitPrice).toFixed(2));
  return done();
}

module.exports = { loadState, newCheckout };
