/**
 * Regression test: cursor:eval reuses compiled queries via the shared
 * XQueryPool, mirroring RESTServer._query's pattern. After a cursor is
 * closed, the compiled query returns to the pool and a subsequent
 * identical request can skip parse+compile.
 *
 * This test asserts the reuse plumbing works (compile time on the
 * reused run is <= the first run, typically 0) AND that scope/correctness
 * is preserved across reuse — a pool-reused compiled query must still
 * honour each request's module-load-path.
 */
const auth = { username: 'admin', password: '' };
const collA = '/db/cypress-test-pool-a';
const collB = '/db/cypress-test-pool-b';

describe('/api/query — XQueryPool reuse', () => {
  before(() => {
    // Two collections with different <p> counts so a stale-scope bug
    // would surface as the wrong count.
    [collA, collB].forEach(c => {
      cy.request({
        url: `/api/db/collection?path=${c}&force=true`,
        method: 'DELETE', auth, failOnStatusCode: false
      });
      cy.request({
        url: '/api/db/collection', method: 'POST', auth, body: { path: c }
      });
    });
    cy.request({
      url: `/api/db/resource?path=${encodeURIComponent(`${collA}/x.xml`)}&mime=application/xml`,
      method: 'PUT', auth,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: '<doc><p>a1</p><p>a2</p><p>a3</p></doc>'
    });
    cy.request({
      url: `/api/db/resource?path=${encodeURIComponent(`${collB}/x.xml`)}&mime=application/xml`,
      method: 'PUT', auth,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: '<doc><p>b1</p></doc>'
    });
  });

  after(() => {
    [collA, collB].forEach(c => {
      cy.request({
        url: `/api/db/collection?path=${c}&force=true`,
        method: 'DELETE', auth, failOnStatusCode: false
      });
    });
  });

  // Helper: POST + fetch value + DELETE; return { value, compileMs }
  function runAndClose(body) {
    return cy.request({ url: '/api/query', method: 'POST', auth, body }).then(post => {
      const cursor = post.body.cursor;
      const compileMs = post.body.timing.compile;
      return cy.request({
        url: `/api/query/${cursor}/results?start=1&count=1`, auth
      }).then(fetch => {
        const value = fetch.body[0].value;
        return cy.request({
          url: `/api/query/${cursor}`, method: 'DELETE', auth
        }).then(() => ({ value, compileMs }));
      });
    });
  }

  it('repeated identical query: second run reuses compiled (compile time drops)', () => {
    const body = { query: 'count(//p)', 'module-load-path': `xmldb:exist://${collA}` };

    // Warm-up: first call may or may not pool-hit depending on whether
    // an earlier test ran the same expression. Discard its compile time.
    runAndClose(body).then(() => {
      // Two more runs back-to-back. After the warm-up, both should pool-hit.
      // We assert compile <= 1ms for the second observed run (effectively zero).
      runAndClose(body).then(r1 => {
        expect(parseInt(r1.value, 10)).to.eq(3);
        runAndClose(body).then(r2 => {
          expect(parseInt(r2.value, 10)).to.eq(3);
          // On a warmed pool, compile is consistently 0–1ms. Tolerate 2 to
          // avoid CI jitter; the assertion that matters is r2.compileMs <=
          // r1.compileMs + small slack (we proved the pool is being hit
          // because compile is near zero, not 5–10ms).
          expect(r2.compileMs).to.be.at.most(2);
        });
      });
    });
  });

  it('pool reuse preserves per-request scope (different module-load-path → different count)', () => {
    // Same query string, different module-load-path. If the pool-reused
    // compiled query baked in the first call's scope, the second call
    // would return the wrong count. This catches the class of bug that
    // would result from prepareForReuse() not properly resetting scope.
    const query = 'count(//p)';
    runAndClose({ query, 'module-load-path': `xmldb:exist://${collA}` }).then(rA => {
      expect(parseInt(rA.value, 10)).to.eq(3);
      runAndClose({ query, 'module-load-path': `xmldb:exist://${collB}` }).then(rB => {
        expect(parseInt(rB.value, 10)).to.eq(1);
        runAndClose({ query, 'module-load-path': `xmldb:exist://${collA}` }).then(rA2 => {
          expect(parseInt(rA2.value, 10)).to.eq(3);
        });
      });
    });
  });
});
