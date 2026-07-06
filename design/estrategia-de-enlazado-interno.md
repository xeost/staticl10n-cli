# Estrategia de Enlazado Interno: Esdocu

El núcleo de esta estrategia se basa en la **Escasez Estratégica** y la **Relevancia Semántica**. El objetivo es canalizar la autoridad ganada por las traducciones en los subdominios hacia los artículos de conversión en el dominio principal de manera completamente orgánica.

## 1. Arquitectura de Autoridad de Marca (Domain Authority)

Para que Google entienda que todos los subdominios pertenecen a una misma entidad confiable y no son sitios satélites aislados, se implementará un enlazado estructural no comercial.

* **Ubicación:** Footer global de cada subdominio (ej. `nestjs.esdocu.com`).
* **Destino:** La página principal (`[https://esdocu.com](https://esdocu.com)`).
* **Texto y Formato:** Un enlace discreto y corporativo como "Traducción mantenida por Esdocu" o "Ver más documentaciones en Esdocu".
* **Propósito:** Consolidar el PageRank global del dominio apex sin levantar sospechas de manipulación de palabras clave.

---

## 2. Cuota Máxima de Enlaces Comerciales por Subdominio

Para evitar el filtro algorítmico de sobre-optimización (spam), cada subdominio tendrá un límite estricto de enlaces que apunten hacia un mismo artículo de afiliados (por ejemplo, `[esdocu.com/mejor-hosting](https://esdocu.com/mejor-hosting)`).

| Ubicación del Enlace | Cantidad Máxima | Enfoque Estratégico |
| --- | --- | --- |
| **Home Page** | 1 Enlace | Sección de "Patrocinador" o "Recursos Recomendados" debajo de la introducción. |
| **Páginas Internas** | 3 a 5 Enlaces | Inserción quirúrgica exclusiva en capítulos técnicos relacionados (Despliegue, Bases de Datos, Seguridad). |
| **Total por Subdominio** | **4 a 6 Enlaces** | Mantiene la densidad por debajo del umbral de riesgo del 5% al 10% del total de páginas. |

---

## 3. Directrices de Ejecución en Páginas Internas (El Enfoque "Francotirador")

El éxito de las conversiones y la seguridad SEO dependerán de cómo se redacten y coloquen estos 3 a 5 enlaces internos.

* **Relevancia Inquebrantable:** El enlace solo existirá si la página habla de un problema que el servicio de afiliados soluciona. (Ejemplo: Enlazar a un artículo de VPN solo desde secciones sobre cifrado o seguridad de red).
* **Variación de Textos Ancla (Anchor Text):** Prohibido repetir el mismo texto en diferentes enlaces. Se utilizarán frases orgánicas integradas en la lectura ("revisa estas opciones de servidores para producción", "dónde alojar este tipo de bases de datos", "proveedores de infraestructura recomendados").
* **Ausencia de Patrones Repetitivos:** Si un subdominio enlaza al artículo de "Mejor Hosting", el siguiente subdominio podría enlazar al artículo de "Mejor VPN" o hacerlo desde secciones con títulos completamente distintos, evitando dejar una huella digital (footprint) idéntica en los cientos de documentaciones.

---

## 4. Protocolo de Seguridad (Lo que NO se debe hacer)

Para garantizar la viabilidad del proyecto a largo plazo, estas acciones quedan bloqueadas en la implementación:

* **Cero enlaces "Sitewide":** No insertar enlaces de afiliados en barras laterales (sidebars) o menús persistentes que se repitan en todas las páginas del subdominio.
* **Sin forzar el contexto:** Si una tecnología específica no requiere servidores, bases de datos o servicios de pago para funcionar, no se incluirá ningún enlace hacia los artículos de conversión en ese subdominio.
* **No sacrificar la experiencia de usuario:** Los enlaces no deben interrumpir el flujo de aprendizaje del desarrollador ni adoptar formatos de banners publicitarios agresivos.
