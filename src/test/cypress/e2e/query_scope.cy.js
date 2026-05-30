/**
 * Regression test: cursor:eval must scope unprefixed path expressions and
 * resolve relative URIs against the collection derived from
 * `module-load-path`, the same way `/exist/rest/<path>?_query=...` scopes
 * to its URL path.
 *
 * Without this, `count(//p)` returns 0 (or err:XPDY0002) because the
 * XQueryContext has no statically-known documents. See
 * RESTServiceTest.queryGet() in eXist core for the analogous coverage on
 * the REST `_query` endpoint, and eXide PR #794 (review by @line-o) for
 * the user-facing report.
 */
const auth = { username: 'admin', password: '' };
const testCollection = '/db/cypress-test-query-scope';

describe('/api/query — context scope', () => {
  before(() => {
    // Clean slate, then store 3 fixture docs: two siblings + one in a
    // sub-collection. Together they contain 5 <p> elements (2+2+1) so
    // /-rooted, //-rooted and `doc()` queries all have distinct expected
    // counts and the test catches partial fixes.
    cy.request({
      url: `/api/db/collection?path=${testCollection}&force=true`,
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
    cy.request({
      url: '/api/db/collection',
      method: 'POST',
      auth,
      body: { path: testCollection }
    });
    cy.request({
      url: '/api/db/resource',
      method: 'PUT',
      auth,
      body: {
        path: `${testCollection}/a.xml`,
        content: '<doc><p>one</p><p>two</p></doc>',
        'mime-type': 'application/xml'
      }
    });
    cy.request({
      url: '/api/db/resource',
      method: 'PUT',
      auth,
      body: {
        path: `${testCollection}/b.xml`,
        content: '<doc><p>three</p><p>four</p></doc>',
        'mime-type': 'application/xml'
      }
    });
    cy.request({
      url: '/api/db/collection',
      method: 'POST',
      auth,
      body: { path: `${testCollection}/sub` }
    });
    cy.request({
      url: '/api/db/resource',
      method: 'PUT',
      auth,
      body: {
        path: `${testCollection}/sub/c.xml`,
        content: '<doc><p>five</p></doc>',
        'mime-type': 'application/xml'
      }
    });
  });

  after(() => {
    cy.request({
      url: `/api/db/collection?path=${testCollection}&force=true`,
      method: 'DELETE',
      auth,
      failOnStatusCode: false
    });
  });

  // Helper: run a query, fetch the single scalar result, close the cursor.
  // Returns the scalar value via the .then chain — caller writes
  //   evalScalar({query: ...}).then(value => expect(...))
  function evalScalar(body) {
    return cy.request({ url: '/api/query', method: 'POST', auth, body })
      .then(post => {
        expect(post.status).to.eq(200);
        const cursor = post.body.cursor;
        return cy.request({
          url: `/api/query/${cursor}/results?start=1&count=1`,
          auth
        }).then(fetch => {
          const value = fetch.body[0].value;
          // Close cursor; chain via .then() so Cypress sees a single async chain
          // and the helper resolves to `value` (not the DELETE response).
          return cy.request({ url: `/api/query/${cursor}`, method: 'DELETE', auth })
            .then(() => value);
        });
      });
  }

  it('//p with module-load-path scoped to test collection sees only its 5 <p> elements', () => {
    evalScalar({
      query: 'count(//p)',
      'module-load-path': `xmldb:exist://${testCollection}`
    }).then(value => {
      // 2 in a.xml + 2 in b.xml + 1 in sub/c.xml = 5
      expect(parseInt(value, 10)).to.eq(5);
    });
  });

  it('//p with no module-load-path defaults to /db root and sees at least the 5 fixture <p> elements', () => {
    // No moduleLoadPath supplied → resolveScope() defaults to /db, matching
    // /exist/rest/db semantics. The whole database is in scope, so the
    // count is ≥ 5 (other apps may contribute their own <p> elements).
    evalScalar({ query: 'count(//p)' }).then(value => {
      expect(parseInt(value, 10)).to.be.at.least(5);
    });
  });

  it('relative doc("a.xml") resolves against the base URI derived from module-load-path', () => {
    // Without setBaseURI, a relative doc() lookup fails or resolves to the
    // wrong place. With the fix, "a.xml" resolves to <testCollection>/a.xml.
    evalScalar({
      query: 'count(doc("a.xml")//p)',
      'module-load-path': `xmldb:exist://${testCollection}`
    }).then(value => {
      expect(parseInt(value, 10)).to.eq(2);
    });
  });
});
