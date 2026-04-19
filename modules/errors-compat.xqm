xquery version "3.1";

(:~
 : Built-in compatibility module for Roaster's error codes.
 :
 : Provides error QName variables used by apps to signal HTTP error conditions
 : via XQuery's error() function. The built-in router catches these errors and
 : maps them to appropriate HTTP status codes.
 :)
module namespace errors = "http://e-editiones.org/roaster/errors";

declare variable $errors:UNAUTHORIZED := xs:QName("errors:UNAUTHORIZED_401");
declare variable $errors:FORBIDDEN := xs:QName("errors:FORBIDDEN_403");
declare variable $errors:NOT_FOUND := xs:QName("errors:NOT_FOUND_404");
declare variable $errors:OPERATION := xs:QName("errors:OPERATION");
