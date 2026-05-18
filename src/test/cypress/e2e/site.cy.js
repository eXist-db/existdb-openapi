const auth = { username: 'admin', password: '' };

describe('/api/site', () => {
  describe('GET /api/site/apps', () => {
    it('lists installed applications', () => {
      cy.request({ url: '/api/site/apps', auth }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
        expect(response.body.length).to.be.greaterThan(0);

        const app = response.body[0];
        expect(app).to.have.property('name');
        expect(app).to.have.property('abbrev');
        expect(app).to.have.property('title');
        expect(app).to.have.property('version');
        expect(app).to.have.property('url');
      });
    });

    it('includes exist-api itself', () => {
      cy.request({ url: '/api/site/apps', auth }).then(response => {
        const abbrevs = response.body.map(a => a.abbrev);
        expect(abbrevs).to.include('exist-api');
      });
    });
  });

  describe('GET /api/site/resolve', () => {
    it('resolves link for installed app', () => {
      cy.request({
        url: '/api/site/resolve?app=exist-api&path=/api/system/info',
        auth
      }).then(response => {
        expect(response.body).to.have.property('url');
        expect(response.body.url).to.include('/exist/apps/exist-api/');
      });
    });

    it('falls back to exist-db.org for missing app', () => {
      cy.request({
        url: '/api/site/resolve?app=nonexistent-app&path=/foo',
        auth
      }).then(response => {
        expect(response.body.url).to.include('exist-db.org');
      });
    });
  });
});

describe('/api/search', () => {
  describe('GET /api/search', () => {
    it('searches across apps', () => {
      cy.request({
        url: '/api/search?q=XQuery&limit=3',
        auth
      }).then(response => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('query', 'XQuery');
        expect(response.body).to.have.property('total');
        expect(response.body.results).to.be.an('array');
      });
    });

    it('returns error without query param', () => {
      cy.request({
        url: '/api/search?q=',
        auth
      }).then(response => {
        expect(response.body).to.have.property('error');
      });
    });
  });
});
