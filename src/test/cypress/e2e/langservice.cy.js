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

    describe('namespace scoping (issue #31)', () => {
      it('scopes to the trailing prefix when cursor is at "util:"', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'util:' }
        }).then(response => {
          expect(response.body).to.be.an('array').and.have.length.greaterThan(0);
          response.body.forEach(item => {
            expect(item.label).to.match(/^util:/);
          });
        });
      });

      it('prefix-matches the local-name part ("fn:cou" → "fn:count")', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'fn:cou' }
        }).then(response => {
          expect(response.body).to.be.an('array').and.have.length.greaterThan(0);
          response.body.forEach(item => {
            expect(item.label).to.match(/^fn:cou/i);
          });
        });
      });

      it('drops keywords from the response when cursor is prefixed', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'util:' }
        }).then(response => {
          const keywordKinds = response.body.filter(i => i.kind === 14);
          expect(keywordKinds).to.have.length(0);
        });
      });

      it('returns the full set (and keywords) for a bare partial token', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'cou' }
        }).then(response => {
          // Includes more than a single namespace
          const prefixes = new Set(
            response.body.filter(i => i.label.includes(':'))
                         .map(i => i.label.split(':')[0])
          );
          expect(prefixes.size).to.be.greaterThan(3);
          // Keyword still in the set
          const keywordKinds = response.body.filter(i => i.kind === 14);
          expect(keywordKinds).to.have.length.greaterThan(0);
        });
      });

      it('honors the trailing token in a multi-line expression', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'let $x := 1\nreturn util:' }
        }).then(response => {
          response.body.forEach(item => {
            expect(item.label).to.match(/^util:/);
          });
        });
      });
    });

    describe('filterText / sortText / insertText shaping (issue #31)', () => {
      function findItem(items, label) {
        return items.find(i => i.label === label);
      }

      it('every item carries filterText, sortText, and insertTextFormat', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'count' }
        }).then(response => {
          response.body.forEach(item => {
            expect(item).to.have.property('filterText').that.is.a('string');
            expect(item).to.have.property('sortText').that.is.a('string');
            expect(item).to.have.property('insertTextFormat');
          });
        });
      });

      it('bare-mode fn:* drops the prefix from insertText', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'cou' }
        }).then(response => {
          const fnCount = findItem(response.body, 'fn:count#1');
          expect(fnCount.label).to.eq('fn:count#1');
          expect(fnCount.insertText).to.eq('count()');
          expect(fnCount.filterText).to.eq('count');
        });
      });

      it('prefixed-mode fn:* keeps the prefix the user typed', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'fn:cou' }
        }).then(response => {
          const fnCount = findItem(response.body, 'fn:count#1');
          expect(fnCount.insertText).to.eq('fn:count()');
        });
      });

      it('non-fn namespaces always keep their prefix in insertText', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'log' }
        }).then(response => {
          const utilLog = findItem(response.body, 'util:log#2');
          expect(utilLog).to.exist;
          expect(utilLog.insertText).to.match(/^util:log/);
        });
      });

      it('emits snippet items (FLWOR, try/catch, etc.) in bare mode', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'fo' }
        }).then(response => {
          const snippets = response.body.filter(i => i.kind === 15);
          expect(snippets.length).to.be.greaterThan(0);
          const forSnip = snippets.find(s => s.label === 'for');
          expect(forSnip).to.exist;
          expect(forSnip.insertTextFormat).to.eq(2);
          expect(forSnip.insertText).to.contain('${1:x}');
          expect(forSnip.insertText).to.contain('${2:expr}');
        });
      });

      it('suppresses snippets when the cursor is prefixed', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'util:' }
        }).then(response => {
          const snippets = response.body.filter(i => i.kind === 15);
          expect(snippets).to.have.length(0);
        });
      });

      it('sortText biases fn:* / keywords / user fns into bucket 0', () => {
        cy.request({
          url: '/api/langservice/completions', method: 'POST', auth,
          body: { expression: 'cou' }
        }).then(response => {
          const fnCount = findItem(response.body, 'fn:count#1');
          expect(fnCount.sortText).to.match(/^0_/);
          // other-namespace items bucket higher
          const utilCount = response.body.find(i => i.label.startsWith('util:') && i.kind === 3);
          if (utilCount) {
            expect(utilCount.sortText.charAt(0)).to.not.eq('0');
          }
        });
      });
    });
  });

  describe('POST /api/langservice/hover', () => {
    it('returns LSP-shaped Hover with Markdown contents', () => {
      cy.request({
        url: '/api/langservice/hover', method: 'POST', auth,
        body: { expression: 'count((1, 2))', line: 0, column: 0 }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('contents');
        expect(response.body.contents).to.have.property('kind', 'markdown');
        expect(response.body.contents).to.have.property('value');
        // Fenced XQuery code block for the signature
        expect(response.body.contents.value).to.contain('```xquery');
        expect(response.body.contents.value).to.contain('count(');
        // Parameters section
        expect(response.body.contents.value).to.contain('**Parameters**');
        // Returns section
        expect(response.body.contents.value).to.contain('**Returns:**');
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

    it('renders empty-sequence() return type cleanly (no concat artifact)', () => {
      // Cardinality.EMPTY_SEQUENCE.toXQueryCardinalityString() returns the
      // literal "empty-sequence()", not a postfix marker. Naively concatenating
      // it onto the primary type produced "item()empty-sequence()" /
      // "empty-sequence()empty-sequence()". Regression for that.
      cy.request({
        url: '/api/langservice/hover', method: 'POST', auth,
        body: { expression: 'util:log("info","x")', line: 0, column: 0 }
      }).then(response => {
        const value = response.body.contents.value;
        expect(value).to.contain('**Returns:** `empty-sequence()`');
        expect(value).to.not.match(/empty-sequence\(\)empty-sequence\(\)/);
        expect(value).to.not.match(/item\(\)empty-sequence\(\)/);
      });
    });
  });

  describe('POST /api/langservice/signature-help', () => {
    it('returns LSP-shaped SignatureHelp when cursor is inside a function call', () => {
      cy.request({
        url: '/api/langservice/signature-help', method: 'POST', auth,
        body: { expression: 'substring("abc", 2, 1)', line: 0, column: 17 }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('signatures').that.is.an('array').with.length.greaterThan(0);
        expect(response.body).to.have.property('activeSignature');
        expect(response.body).to.have.property('activeParameter');
        const sig = response.body.signatures[0];
        expect(sig.label).to.contain('substring');
        expect(sig.documentation).to.have.property('kind', 'markdown');
        expect(sig.parameters).to.be.an('array').with.length(3);
        sig.parameters.forEach(p => {
          expect(p.label).to.match(/^\$/);
          expect(p.documentation).to.have.property('kind', 'markdown');
        });
      });
    });

    it('activeParameter advances with commas (top-level)', () => {
      // Cursor at col 17 — past the 2nd comma, so 3rd parameter (index 1 of 0-indexed → 1)
      cy.request({
        url: '/api/langservice/signature-help', method: 'POST', auth,
        body: { expression: 'substring("abc", 2, 1)', line: 0, column: 17 }
      }).then(response => {
        expect(response.body.activeParameter).to.eq(1);
      });
    });

    it('returns null when cursor is not inside a function call', () => {
      cy.request({
        url: '/api/langservice/signature-help', method: 'POST', auth,
        body: { expression: '1 + 2', line: 0, column: 3 }
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.null;
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
