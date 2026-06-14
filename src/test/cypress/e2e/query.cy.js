const auth = { username: 'admin', password: '' };

describe('/api/query', () => {
  describe('cursor lifecycle: execute → fetch → close', () => {
    let cursorId;

    it('POST /api/query — executes query and returns cursor', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '1 to 10' }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('cursor');
        expect(response.body.items).to.eq(10);
        expect(response.body).to.have.property('elapsed');
        expect(response.body).to.have.property('timing');
        expect(response.body.timing).to.have.property('compile');
        expect(response.body.timing).to.have.property('evaluate');
        cursorId = response.body.cursor;
      });
    });

    it('GET /api/query/{id}/results — fetches first page', () => {
      cy.request({
        url: `/api/query/${cursorId}/results?start=1&count=5`,
        auth
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        expect(response.body).to.have.length(5);
        expect(response.body[0].value).to.eq('1');
        expect(response.body[4].value).to.eq('5');
        expect(response.body[0].type).to.eq('xs:integer');
      });
    });

    it('GET /api/query/{id}/results — fetches second page', () => {
      cy.request({
        url: `/api/query/${cursorId}/results?start=6&count=5`,
        auth
      }).then(response => {
        expect(response.body).to.have.length(5);
        expect(response.body[0].value).to.eq('6');
        expect(response.body[4].value).to.eq('10');
      });
    });

    it('DELETE /api/query/{id} — closes cursor', () => {
      cy.request({
        url: `/api/query/${cursorId}`,
        method: 'DELETE',
        auth
      }).then(response => {
        expect(response.body).to.have.property('closed', true);
      });
    });
  });

  describe('XML query results', () => {
    it('executes and fetches XML results', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '<root><item n="1"/><item n="2"/></root>/item' }
      }).then(response => {
        expect(response.body.items).to.eq(2);
        const cursor = response.body.cursor;

        cy.request({
          url: `/api/query/${cursor}/results?start=1&count=2`,
          auth
        }).then(fetchResponse => {
          expect(fetchResponse.body).to.have.length(2);
          expect(fetchResponse.body[0].type).to.eq('element()');
          expect(fetchResponse.body[0].value).to.include('n="1"');
        });

        cy.request({ url: `/api/query/${cursor}`, method: 'DELETE', auth });
      });
    });
  });

  describe('adaptive serialization of atomic types', () => {
    // Executes a single-item query and passes the fetched result map to the callback.
    function runAdaptiveQuery(query, then) {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query }
      }).then(postResponse => {
        const cursor = postResponse.body.cursor;
        cy.request({
          url: `/api/query/${cursor}/results?start=1&count=1`,
          auth
        }).then(fetchResponse => {
          then(fetchResponse.body[0]);
          cy.request({ url: `/api/query/${cursor}`, method: 'DELETE', auth });
        });
      });
    }

    // Numerics with XQuery literal syntax

    it('xs:integer — bare number, no quoting', () => {
      runAdaptiveQuery('5', item => {
        expect(item.value).to.eq('5');
        expect(item.type).to.eq('xs:integer');
      });
    });

    it('xs:decimal — bare decimal, no quoting', () => {
      runAdaptiveQuery('1.2', item => {
        expect(item.value).to.eq('1.2');
        expect(item.type).to.eq('xs:decimal');
      });
    });

    it('xs:double — exponential notation, no quoting', () => {
      runAdaptiveQuery('xs:double(1e0)', item => {
        expect(item.value).to.eq('1.0e0');
        expect(item.type).to.eq('xs:double');
      });
    });

    it('xs:float — constructor syntax xs:float("…")', () => {
      // xs:float uses constructor syntax because it has no XQuery literal form.
      // The exact lexical form depends on canonical float representation.
      runAdaptiveQuery('xs:float("1e0")', item => {
        expect(item.value).to.match(/^xs:float\("/);
        expect(item.type).to.eq('xs:float');
      });
    });

    it('xs:boolean true — true() function-call syntax', () => {
      runAdaptiveQuery('true()', item => {
        expect(item.value).to.eq('true()');
        expect(item.type).to.eq('xs:boolean');
      });
    });

    it('xs:boolean false — false() function-call syntax', () => {
      runAdaptiveQuery('false()', item => {
        expect(item.value).to.eq('false()');
        expect(item.type).to.eq('xs:boolean');
      });
    });

    // String-like types: double-quoted, internal quotes doubled (no client escaping needed)

    it('xs:string — double-quoted, client displays value as-is', () => {
      runAdaptiveQuery('"simple string"', item => {
        expect(item.value).to.eq('"simple string"');
        expect(item.type).to.eq('xs:string');
      });
    });

    it('xs:string — internal double-quotes are doubled, not backslash-escaped', () => {
      // XQuery: "hello ""world""" contains the string: hello "world"
      // Adaptive output: "hello ""world""" (outer quotes + doubled inner quotes)
      runAdaptiveQuery('"hello ""world"""', item => {
        expect(item.value).to.eq('"hello ""world"""');
        expect(item.type).to.eq('xs:string');
      });
    });

    it('xs:anyURI — double-quoted like xs:string', () => {
      runAdaptiveQuery('xs:anyURI("http://www.example.org/")', item => {
        expect(item.value).to.eq('"http://www.example.org/"');
        expect(item.type).to.eq('xs:anyURI');
      });
    });

    it('xs:untypedAtomic — double-quoted like xs:string', () => {
      runAdaptiveQuery('xs:untypedAtomic("untypedAtomic")', item => {
        expect(item.value).to.eq('"untypedAtomic"');
        expect(item.type).to.eq('xs:untypedAtomic');
      });
    });

    // Date/time types: constructor syntax typename("lexical-value")

    it('xs:dateTime — constructor syntax', () => {
      runAdaptiveQuery('xs:dateTime("1999-05-31T13:20:00-05:00")', item => {
        expect(item.value).to.eq('xs:dateTime("1999-05-31T13:20:00-05:00")');
        expect(item.type).to.eq('xs:dateTime');
      });
    });

    it('xs:date — constructor syntax', () => {
      runAdaptiveQuery('xs:date("1999-05-31")', item => {
        expect(item.value).to.eq('xs:date("1999-05-31")');
        expect(item.type).to.eq('xs:date');
      });
    });

    it('xs:time — constructor syntax', () => {
      runAdaptiveQuery('xs:time("12:00:00")', item => {
        expect(item.value).to.eq('xs:time("12:00:00")');
        expect(item.type).to.eq('xs:time');
      });
    });

    it('xs:duration — constructor syntax', () => {
      runAdaptiveQuery('xs:duration("P1Y2M3DT10H30M23S")', item => {
        expect(item.value).to.eq('xs:duration("P1Y2M3DT10H30M23S")');
        expect(item.type).to.eq('xs:duration');
      });
    });

    // Binary types: constructor syntax

    it('xs:base64Binary — constructor syntax', () => {
      runAdaptiveQuery('xs:base64Binary("01001010")', item => {
        expect(item.value).to.eq('xs:base64Binary("01001010")');
        expect(item.type).to.eq('xs:base64Binary');
      });
    });

    it('xs:hexBinary — constructor syntax, uppercase hex digits', () => {
      runAdaptiveQuery('xs:hexBinary("D74D35D35D35")', item => {
        expect(item.value).to.eq('xs:hexBinary("D74D35D35D35")');
        expect(item.type).to.eq('xs:hexBinary');
      });
    });

    // QName: Q{namespace}localname syntax

    it('xs:QName — Q{namespace}localname syntax', () => {
      runAdaptiveQuery('xs:QName("xs:integer")', item => {
        expect(item.value).to.eq('Q{http://www.w3.org/2001/XMLSchema}integer');
        expect(item.type).to.eq('xs:QName');
      });
    });
  });

  describe('error handling', () => {
    it('returns HTTP 400 for missing query', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body).to.have.property('error');
      });
    });

    // Regression: PR #41's try/catch wrapped every cursor:eval error with
    // "Invalid context-item:" AND returned HTTP 200, breaking eXide's
    // error-display path (which relies on `if (!response.ok)`).
    // cursor:eval errors must surface with their original code and a non-200
    // status, never mislabeled as a context-item error.
    it('surfaces a cursor:eval error as a structured QueryError, not a 200', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '//does-not-exist:foo' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        // QueryError envelope: { code, message, line, column, raw }
        expect(response.body.code).to.match(/XPST0081/);
        expect(response.body).to.have.property('message');
        expect(response.body).to.have.property('raw');
        // Must NOT be mislabeled as a context-item error
        expect(response.body.message).to.not.include('Invalid context-item');
        expect(response.body.raw).to.not.include('Invalid context-item');
      });
    });

    // The envelope must carry user-relative line/column (the position in the
    // submitted query) so an editor can place a marker — not the wrapper-module
    // coordinates the uncaught error used to leak.
    it('reports user-relative line/column and a clean message for a syntax error', () => {
      cy.request({
        url: '/api/query', method: 'POST', auth,
        body: { query: '1 to' }, failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body.code).to.eq('err:XPST0003');
        expect(response.body.line).to.eq(1);
        expect(response.body.column).to.eq(5);
        expect(response.body.message).to.eq('unexpected token: null');
        // clean message: no Java class, no W3C boilerplate, no [at line] suffix
        expect(response.body.message).to.not.include('org.exist');
        expect(response.body.message).to.not.include('It is a static error');
        expect(response.body.message).to.not.include('[at line');
      });
    });

    // line/column track the user's frame: the error moves with the input.
    it('tracks the error line when the query is preceded by blank lines', () => {
      cy.request({
        url: '/api/query', method: 'POST', auth,
        body: { query: '\n\n1 to' }, failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body.line).to.eq(3);
        expect(response.body.column).to.eq(5);
      });
    });

    it('returns HTTP 400 with proper prefix for malformed context-item', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '.', 'context-item': '<not-well-formed' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body.error).to.include('Invalid context-item');
      });
    });
  });

  describe('documentURI / nodeId in results (issue #40)', () => {
    const testDoc = '/db/cypress-test-uri.xml';

    before(() => {
      cy.request({
        url: '/api/db/resource', method: 'PUT', auth,
        body: {
          path: testDoc,
          content: '<doc><para>one</para><para>two</para></doc>',
          'mime-type': 'application/xml'
        }
      });
    });

    after(() => {
      cy.request({
        url: `/api/db/resource?path=${testDoc}`,
        method: 'DELETE', auth, failOnStatusCode: false
      });
    });

    function runAndFetch(query, then) {
      cy.request({
        url: '/api/query', method: 'POST', auth, body: { query }
      }).then(postResponse => {
        const cursor = postResponse.body.cursor;
        cy.request({
          url: `/api/query/${cursor}/results?start=1&count=10`, auth
        }).then(fetchResponse => {
          then(fetchResponse.body);
          cy.request({ url: `/api/query/${cursor}`, method: 'DELETE', auth });
        });
      });
    }

    it('populates documentURI and nodeId for stored-doc nodes', () => {
      runAndFetch(`doc("${testDoc}")//para`, items => {
        expect(items).to.have.length(2);
        items.forEach(it => {
          expect(it.documentURI).to.eq(testDoc);
          expect(it.nodeId).to.not.eq('');
          expect(it.nodeId).to.match(/^\d/);
        });
        // The two paras must have distinct node IDs
        expect(items[0].nodeId).to.not.eq(items[1].nodeId);
      });
    });

    it('leaves documentURI and nodeId empty for atomic results', () => {
      runAndFetch('1 to 3', items => {
        items.forEach(it => {
          expect(it.documentURI).to.eq('');
          expect(it.nodeId).to.eq('');
        });
      });
    });

    it('leaves documentURI and nodeId empty for in-memory nodes', () => {
      runAndFetch('<root><x/></root>/x', items => {
        expect(items).to.have.length(1);
        expect(items[0].documentURI).to.eq('');
        expect(items[0].nodeId).to.eq('');
      });
    });
  });

  describe('context-item / context-path', () => {
    const testDoc = '/db/cypress-test-query-ctx.xml';

    before(() => {
      cy.request({
        url: `/api/db/resource`,
        method: 'PUT',
        auth,
        body: {
          path: testDoc,
          content: '<doc><para>one</para><para>two</para><para>three</para></doc>',
          'mime-type': 'application/xml'
        }
      });
    });

    after(() => {
      cy.request({
        url: `/api/db/resource?path=${testDoc}`,
        method: 'DELETE',
        auth,
        failOnStatusCode: false
      });
    });

    function fetchOne(cursor) {
      return cy.request({ url: `/api/query/${cursor}/results?start=1&count=10`, auth });
    }

    it('evaluates //x against inline context-item XML', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: {
          query: 'count(//item)',
          'context-item': '<root><item/><item/><item/></root>'
        }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('cursor');
        fetchOne(response.body.cursor).then(r => {
          expect(r.body[0].value).to.eq('3');
        });
      });
    });

    it('evaluates //x against a db document via context-path', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: {
          query: 'count(//para)',
          'context-path': testDoc
        }
      }).then(response => {
        expect(response.status).to.eq(200);
        fetchOne(response.body.cursor).then(r => {
          expect(r.body[0].value).to.eq('3');
        });
      });
    });

    it('context-path takes precedence over context-item', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: {
          query: 'count(//para)',
          'context-path': testDoc,
          'context-item': '<other><para/></other>'
        }
      }).then(response => {
        fetchOne(response.body.cursor).then(r => {
          expect(r.body[0].value).to.eq('3');
        });
      });
    });

    it('returns error for malformed context-item XML', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '.', 'context-item': '<not-well-formed' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(400);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('context-item');
      });
    });

    it('returns error for nonexistent context-path', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '.', 'context-path': '/db/nonexistent-xyz.xml' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.eq(404);
        expect(response.body).to.have.property('error');
        expect(response.body.error).to.include('not found');
      });
    });
  });

  describe('external variable bindings (variables)', () => {
    // POST a query with a `variables` map, fetch the first page, hand it to `then`, then close.
    function runWithVars(query, variables, then) {
      cy.request({
        url: '/api/query', method: 'POST', auth, body: { query, variables }
      }).then(postResponse => {
        expect(postResponse.status).to.eq(200);
        const cursor = postResponse.body.cursor;
        cy.request({
          url: `/api/query/${cursor}/results?start=1&count=10`, auth
        }).then(fetchResponse => {
          then(fetchResponse.body);
          cy.request({ url: `/api/query/${cursor}`, method: 'DELETE', auth });
        });
      });
    }

    it('binds a scalar string to an external variable', () => {
      runWithVars(
        'declare variable $greeting external; <g>{$greeting}</g>',
        { greeting: 'hello' },
        items => {
          expect(items).to.have.length(1);
          expect(items[0].value).to.eq('<g>hello</g>');
        });
    });

    it('binds a JSON number as xs:double', () => {
      runWithVars(
        'declare variable $n external; (xs:integer($n) * 2, $n instance of xs:double)',
        { n: 21 },
        items => {
          expect(items[0].value).to.eq('42');
          expect(items[1].value).to.eq('true()');
        });
    });

    it('binds a JSON array as array(*); members are reached with ?*', () => {
      runWithVars(
        'declare variable $ids external; (array:size($ids), count($ids?*), string-join($ids?*, "|"))',
        { ids: ['d278', 'd300', 'd12'] },
        items => {
          expect(items[0].value).to.eq('3');                 // array:size — bound as an array
          expect(items[1].value).to.eq('3');                 // count($ids?*) — members as a sequence
          expect(items[2].value).to.eq('"d278|d300|d12"');   // adaptive-quoted xs:string
        });
    });

    it('binds a JSON object as map(*)', () => {
      runWithVars(
        'declare variable $opts external; $opts?indent',
        { opts: { indent: 'yes', method: 'xml' } },
        items => {
          expect(items[0].value).to.eq('"yes"');
        });
    });

    it('ignores a supplied name with no matching external declaration', () => {
      runWithVars(
        'declare variable $used external; <r>{$used}</r>',
        { used: 'X', unused: 'Y' },
        items => {
          expect(items[0].value).to.eq('<r>X</r>');
        });
    });

    it('a missing required external variable propagates as an XQuery error', () => {
      // No default and no supplied value → XPDY0002 from cursor:eval, which
      // propagates with a non-200 status and structured fields (not a 200 error map).
      cy.request({
        url: '/api/query', method: 'POST', auth,
        body: { query: 'declare variable $required external; $required' },
        failOnStatusCode: false
      }).then(response => {
        expect(response.status).to.be.oneOf([400, 500]);
        expect(response.body).to.have.property('code');
        expect(response.body.code).to.match(/XPDY0002/);
      });
    });
  });
});
