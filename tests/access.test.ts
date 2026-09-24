import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accessKind,accessLabel,fullCopyAccess} from '../src/access.js';

test('books, magazines and journals are classified by how they can legitimately be read',()=>{
 const cases:[string,string][]=[
   ['https://play.google.com/store/books/details/Robert_Greene_The_Art_of_Seduction?id=abc','store'],
   ['https://www.penguinrandomhouse.com/books/331432/the-art-of-seduction-by-robert-greene/','store'],
   ['https://www.amazon.com/Art-Seduction-Robert-Greene/dp/0142001198','store'],
   ['https://libbyapp.com/library/nypl/everything/page-1/123','library'],
   ['https://openlibrary.org/works/OL123W/The_Art_of_Seduction','library'],
   ['https://www.scribd.com/book/211437/The-Art-of-Seduction','subscription'],
   ['https://www.pressreader.com/usa/time/20240101','subscription'],
   ['https://arxiv.org/abs/2401.00001','open_access'],
   ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/','open_access'],
   ['https://www.gutenberg.org/ebooks/1342','public_domain'],
   ['https://www.scribd.com/document/757161093/The-Art-of-Seduction-Robert-Greene','unknown'],
   ['https://archive.org/details/some-upload','unknown'],
   ['https://libgen.is/book/index.php?md5=x','unauthorized'],
   ['https://z-library.sk/book/1','unauthorized'],
   ['https://sci-hub.se/10.1000/xyz','unauthorized'],
   ['https://oceanofpdf.com/authors/robert-greene/pdf-the-art-of-seduction/','unauthorized'],
   ['https://en.wikipedia.org/wiki/Roswell_incident','unknown'],
 ];
 for(const [url,kind] of cases)assert.equal(accessKind(url),kind,url);
});

test('only legitimate access kinds count as full-copy access, each with a label',()=>{
 for(const kind of ['store','library','subscription','open_access','public_domain','publisher'] as const)assert.equal(fullCopyAccess(kind),true,kind);
 for(const kind of ['unknown','unauthorized'] as const)assert.equal(fullCopyAccess(kind),false,kind);
 assert.equal(accessLabel('store'),'Buy');assert.equal(accessLabel('library'),'Borrow');assert.equal(accessLabel('unknown'),null);
});
