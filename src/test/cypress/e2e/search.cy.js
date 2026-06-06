const auth = { username: 'admin', password: '' };

// These tests rely on the `doc` app (eXist documentation) being installed and
// full-text indexed — it ships with the existdb/existdb image. "xquery" is a
// term with many hits across the docs.
describe('/api/search', () => {
  describe('GET /api/search', () => {
    it('requires the q parameter', () => {
      cy.request({ url: '/api/search', auth, failOnStatusCode: false }).then(response => {
        // Missing required query parameter — roaster rejects with 400.
        expect(response.status).to.eq(400);
      });
    });

    it('returns the documented shape: query, total, offset, limit, results', () => {
      cy.request({ url: '/api/search?q=xquery&limit=5', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('query', 'xquery');
        expect(response.body).to.have.property('total').that.is.a('number');
        expect(response.body).to.have.property('offset', 0);
        expect(response.body).to.have.property('limit', 5);
        expect(response.body.results).to.be.an('array');
        expect(response.body.total).to.be.greaterThan(0);
      });
    });

    it('orders results by descending relevance score', () => {
      cy.request({ url: '/api/search?q=xquery&limit=10', auth }).then(response => {
        const scores = response.body.results.map(r => r.score);
        scores.forEach(s => expect(s).to.be.a('number').and.to.be.greaterThan(0));
        for (let i = 1; i < scores.length; i++) {
          expect(scores[i]).to.be.at.most(scores[i - 1]);
        }
      });
    });

    it('wraps matched terms in <mark> in snippet and highlights', () => {
      cy.request({ url: '/api/search?q=xquery&limit=5', auth }).then(response => {
        const hit = response.body.results.find(
          r => r.snippet && /<mark>/i.test(r.snippet)
        );
        expect(hit, 'a result with a <mark> snippet').to.exist;
        expect(hit.snippet).to.match(/<mark>.*<\/mark>/i);
        expect(hit.highlights).to.be.an('array');
        expect(hit.highlights.some(h => /<mark>/i.test(h))).to.eq(true);
      });
    });

    it('exposes a canonical document identifier (uri / path)', () => {
      cy.request({ url: '/api/search?q=xquery&limit=1', auth }).then(response => {
        const hit = response.body.results[0];
        expect(hit).to.have.property('uri').that.matches(/^\/db\//);
        expect(hit).to.have.property('path', hit.uri);
        expect(hit).to.have.property('app');
        expect(hit).to.have.property('url');
      });
    });

    it('returns well-formed, single-rooted <span> XML snippets (parse-xml friendly)', () => {
      cy.request({ url: '/api/search?q=xquery&limit=5', auth }).then(response => {
        const isWellFormed = (s) => {
          expect(s, 'fragment is wrapped in a single <span> root').to.match(
            /^<span>[\s\S]*<\/span>$/
          );
          const doc = new DOMParser().parseFromString(s, 'application/xml');
          expect(doc.querySelector('parsererror'), 'fragment parses as XML').to.be.null;
          expect(doc.documentElement.nodeName).to.eq('span');
        };
        response.body.results.forEach(r => {
          isWellFormed(r.snippet);
          r.highlights.forEach(isWellFormed);
        });
      });
    });

    it('returns one result per document (deduplicated)', () => {
      cy.request({ url: '/api/search?q=xquery&limit=50', auth }).then(response => {
        const uris = response.body.results.map(r => r.uri);
        expect(uris.length).to.eq(new Set(uris).size);
      });
    });

    it('pages through results with offset/limit', () => {
      cy.request({ url: '/api/search?q=xquery&limit=3&offset=0', auth }).then(page1 => {
        // Only meaningful when there is more than one page of results.
        if (page1.body.total <= 3) return;
        cy.request({ url: '/api/search?q=xquery&limit=3&offset=3', auth }).then(page2 => {
          expect(page2.body.offset).to.eq(3);
          const u1 = new Set(page1.body.results.map(r => r.uri));
          page2.body.results.forEach(r => expect(u1.has(r.uri)).to.eq(false));
        });
      });
    });

    it('restricts to a single app with the app parameter', () => {
      cy.request({ url: '/api/search?q=xquery&app=doc&limit=10', auth }).then(response => {
        expect(response.status).to.eq(200);
        response.body.results.forEach(r => expect(r.app).to.eq('doc'));
      });
    });
  });
});
