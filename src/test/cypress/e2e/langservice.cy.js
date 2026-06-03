const auth = { username: 'admin', password: '' };

// Coverage for the /api/langservice/* endpoints. The hover/definition/references
// cases are regression tests: their `line`/`column` arrive from JSON as xs:double,
// and the underlying lang:* functions declare xs:integer parameters, so without a
// coercion these endpoints failed with err:XPTY0004 (HTTP 500).
describe('/api/langservice', () => {

  describe('GET /api/langservice/capabilities', () => {
    it('reports the available language services', () => {
      cy.request({ url: '/api/langservice/capabilities', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('diagnostics');
        expect(response.body).to.have.property('completions');
        expect(response.body).to.have.property('hover');
        expect(response.body).to.have.property('definition');
      });
    });
  });

  describe('POST /api/langservice/diagnostics', () => {
    it('returns an empty array for a valid expression', () => {
      cy.request({
        url: '/api/langservice/diagnostics', method: 'POST', auth,
        body: { expression: '1 + 1' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array').that.is.empty;
      });
    });

    it('reports a diagnostic for an invalid expression', () => {
      cy.request({
        url: '/api/langservice/diagnostics', method: 'POST', auth,
        body: { expression: '1 +' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array').and.have.length.greaterThan(0);
        const problem = response.body[0];
        expect(problem).to.have.all.keys('line', 'column', 'severity', 'code', 'message');
        expect(problem.line).to.be.a('number');
        expect(problem.column).to.be.a('number');
        expect(problem.severity).to.eq(1);
      });
    });
  });

  describe('POST /api/langservice/completions', () => {
    it('returns completion proposals', () => {
      cy.request({
        url: '/api/langservice/completions', method: 'POST', auth,
        body: { expression: 'count' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array').and.have.length.greaterThan(0);
        expect(response.body[0]).to.have.property('label');
        expect(response.body[0]).to.have.property('kind');
      });
    });
  });

  describe('POST /api/langservice/hover', () => {
    it('returns signature and documentation at a position', () => {
      cy.request({
        url: '/api/langservice/hover', method: 'POST', auth,
        body: { expression: 'count((1, 2))', line: 0, column: 0 }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('kind', 'function');
        expect(response.body.contents).to.contain('count');
      });
    });

    it('accepts line/column as JSON numbers (regression: XPTY0004)', () => {
      cy.request({
        url: '/api/langservice/hover', method: 'POST', auth,
        body: { expression: 'true()', line: 0, column: 0 }
      }).then(response => {
        expect(response.status).to.eq(200);
      });
    });
  });

  describe('POST /api/langservice/definition', () => {
    it('resolves a same-module function definition', () => {
      cy.request({
        url: '/api/langservice/definition', method: 'POST', auth,
        body: {
          expression: 'declare function local:f() { 1 };\nlocal:f()',
          line: 1, column: 0
        }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('name', 'local:f#0');
        expect(response.body).to.have.property('line');
        expect(response.body).to.have.property('column');
        expect(response.body).to.have.property('kind', 'function');
      });
    });
  });

  describe('POST /api/langservice/references', () => {
    it('returns an array of references (regression: XPTY0004)', () => {
      cy.request({
        url: '/api/langservice/references', method: 'POST', auth,
        body: { expression: 'let $x := 1 return $x + $x', line: 0, column: 4 }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
      });
    });
  });

  describe('POST /api/langservice/symbols', () => {
    it('lists functions and variables with positions', () => {
      cy.request({
        url: '/api/langservice/symbols', method: 'POST', auth,
        body: {
          expression: 'declare function local:f() { 1 };\n'
            + 'declare variable $v := 2;\nlocal:f()'
        }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array').and.have.length.greaterThan(0);
        expect(response.body[0]).to.have.property('name');
        expect(response.body[0]).to.have.property('kind');
        expect(response.body[0]).to.have.property('line');
      });
    });
  });
});
