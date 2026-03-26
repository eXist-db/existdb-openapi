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

  describe('error handling', () => {
    it('returns error for missing query', () => {
      cy.request({
        url: '/api/query',
        method: 'POST',
        auth,
        body: { query: '' }
      }).then(response => {
        expect(response.body).to.have.property('error');
      });
    });
  });
});
